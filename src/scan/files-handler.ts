import type { Context } from "hono";
import { getProviders } from "../providers";
import { detectPii } from "../pii/detector";
import type { PiiCategory, AuthInfo } from "../types";
import { getScanFn } from "./registry";
import { getAction } from "../actions/registry";
import type {
  ScanCheck,
  ScanFilesRequest,
  ScanFilesResponse,
  ScanFileResult,
  ScanCheckResult,
  PiiResult,
} from "./types";

// Map scan check names to action types in the action registry
const CHECK_TO_ACTION: Record<string, string> = {
  ai_pii: "ai_detect_pii",
  injection: "ai_detect_injection",
  toxicity: "ai_detect_toxicity",
  dlp: "ai_detect_dlp",
  compliance: "ai_detect_compliance",
};

// Reverse map: action type → scan check name
const ACTION_TO_CHECK: Record<string, string> = Object.fromEntries(
  Object.entries(CHECK_TO_ACTION).map(([check, action]) => [action, check]),
);

/** Resolve a scan function: try scan registry first, then action registry */
function resolveScanFn(check: string): ((text: string) => Promise<unknown>) | undefined {
  const scanFn = getScanFn(check);
  if (scanFn) return scanFn;

  const actionType = CHECK_TO_ACTION[check];
  if (actionType) {
    const action = getAction(actionType);
    if (action?.scan) return (text) => action.scan!(text);
  }

  return undefined;
}

const ALL_CHECKS: ScanCheck[] = ["pii", "ai_pii", "toxicity", "injection", "dlp", "compliance"];

const PRO_CHECKS: Set<ScanCheck> = new Set(["pii", "ai_pii"]);

const BUSINESS_CHECKS: Set<ScanCheck> = new Set(ALL_CHECKS);

const AI_CHECKS: Set<ScanCheck> = new Set(["ai_pii", "toxicity", "injection", "dlp", "compliance"]);

const MAX_FILES = 50;
const MAX_FILE_BYTES = 51_200; // 50KB per file
const MAX_PAYLOAD_BYTES = 512_000; // 500KB total

const PII_CATEGORIES: PiiCategory[] = [
  "email", "phone", "ssn", "credit_card", "ip_address", "address", "date_of_birth",
];

function checksForTier(tier: string): Set<ScanCheck> {
  switch (tier) {
    case "business":
    case "custom":
      return BUSINESS_CHECKS;
    case "pro":
      return PRO_CHECKS;
    default:
      return PRO_CHECKS;
  }
}

async function authenticate(c: Context): Promise<{ error: Response } | { auth: AuthInfo }> {
  const providers = getProviders();
  const authHeader = c.req.header("authorization") || "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!apiKey) {
    return { error: c.json({ error: "Missing Authorization header" }, 401) };
  }

  let auth;
  try {
    auth = await providers.auth.authenticate(apiKey);
  } catch (err) {
    console.error("Auth error:", err);
    return { error: c.json({ error: "Authentication service error" }, 500) };
  }

  if (!auth) {
    return { error: c.json({ error: "Invalid API key" }, 401) };
  }

  return { auth };
}

export async function scanFilesHandler(c: Context): Promise<Response> {
  const result = await authenticate(c);
  if ("error" in result) return result.error;
  const { auth } = result;

  const providers = getProviders();

  // Rate/quota check
  try {
    const rateQuota = await providers.rateQuota.check(auth.team_id, auth.tier);
    if (!rateQuota.rate.allowed) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }
    if (!rateQuota.quota.allowed) {
      return c.json({ error: "Monthly quota exceeded" }, 429);
    }
  } catch (err) {
    console.error("Rate/quota check error:", err);
    // Fail open
  }

  // Parse + validate body
  let body: ScanFilesRequest;
  try {
    body = await c.req.json<ScanFilesRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(body.files) || body.files.length === 0) {
    return c.json({ error: "files must be a non-empty array" }, 400);
  }

  if (body.files.length > MAX_FILES) {
    return c.json({ error: `Maximum ${MAX_FILES} files per request` }, 400);
  }

  if (!Array.isArray(body.checks) || body.checks.length === 0) {
    return c.json({ error: "checks must be a non-empty array" }, 400);
  }

  const invalidChecks = body.checks.filter((ch) => !ALL_CHECKS.includes(ch));
  if (invalidChecks.length > 0) {
    return c.json({ error: `Invalid checks: ${invalidChecks.join(", ")}` }, 400);
  }

  // Validate total payload size
  const encoder = new TextEncoder();
  let totalBytes = 0;
  for (const file of body.files) {
    if (!file.path || typeof file.path !== "string") {
      return c.json({ error: "Each file must have a path string" }, 400);
    }
    if (!file.text || typeof file.text !== "string") {
      return c.json({ error: "Each file must have a text string" }, 400);
    }
    totalBytes += encoder.encode(file.text).length;
  }

  if (totalBytes > MAX_PAYLOAD_BYTES) {
    return c.json({ error: "Total payload exceeds 500KB limit" }, 400);
  }

  // Load team rules and extract which AI checks are enabled
  const allRules = await providers.rules.loadRules(auth.team_id);
  const enabledChecks = new Set<string>();
  for (const rule of allRules) {
    if (!rule.enabled) continue;
    for (const action of rule.actions) {
      if (!action.enabled) continue;
      const check = ACTION_TO_CHECK[action.type];
      if (check) enabledChecks.add(check);
    }
  }

  // Determine which checks this tier allows
  const allowedChecks = checksForTier(auth.tier);
  const checksRun: string[] = [];
  const checksSkipped: Array<{ check: string; reason: string }> = [];

  // Resolve tier gating + rule gating
  const effectiveChecks: ScanCheck[] = [];
  for (const check of body.checks) {
    if (check === "pii") {
      // pii (regex) is always allowed — doesn't require a rule
      effectiveChecks.push(check);
    } else if (!enabledChecks.has(check)) {
      checksSkipped.push({ check, reason: "no_matching_rule" });
    } else if (!allowedChecks.has(check)) {
      const reason = PRO_CHECKS.has(check) ? "requires_pro" : "requires_business";
      checksSkipped.push({ check, reason });
    } else {
      effectiveChecks.push(check);
    }
  }

  // Check AI sampling for free tier (once per request)
  let aiQuotaExceeded = false;
  if (auth.tier === "free") {
    const hasAiChecks = effectiveChecks.some((ch) => AI_CHECKS.has(ch));
    if (hasAiChecks) {
      try {
        const sampling = await providers.rateQuota.checkAiSampling(auth.team_id, auth.tier);
        if (!sampling.allowed) {
          aiQuotaExceeded = true;
        }
      } catch (err) {
        console.error("AI sampling check error:", err);
      }
    }
  }

  // If AI quota exceeded, move AI checks to skipped
  if (aiQuotaExceeded) {
    const remaining: ScanCheck[] = [];
    for (const check of effectiveChecks) {
      if (AI_CHECKS.has(check)) {
        checksSkipped.push({ check, reason: "ai_quota_exceeded" });
      } else {
        remaining.push(check);
      }
    }
    effectiveChecks.length = 0;
    effectiveChecks.push(...remaining);
  }

  // Resolve scan functions once — separate available from unavailable
  const runnableChecks: ScanCheck[] = [];
  const resolvedFns = new Map<string, (text: string) => Promise<unknown>>();
  for (const check of effectiveChecks) {
    if (check === "pii") {
      runnableChecks.push(check);
      checksRun.push(check);
    } else {
      const fn = resolveScanFn(check);
      if (fn) {
        runnableChecks.push(check);
        checksRun.push(check);
        resolvedFns.set(check, fn);
      } else {
        checksSkipped.push({ check, reason: "unavailable" });
      }
    }
  }

  // Process each file
  const fileResults: ScanFileResult[] = [];

  for (const file of body.files) {
    const fileBytes = encoder.encode(file.text).length;

    // Skip files that are too large
    if (fileBytes > MAX_FILE_BYTES) {
      fileResults.push({
        path: file.path,
        results: {},
        skipped: "text_too_large",
      });
      continue;
    }

    const results: Record<string, ScanCheckResult> = {};

    for (const check of runnableChecks) {
      if (check === "pii") {
        const matches = detectPii(file.text, PII_CATEGORIES);
        results.pii = {
          matches: matches.map((m) => ({
            category: m.category,
            match: m.match,
            start: m.start,
            end: m.end,
          })),
        } as PiiResult;
        continue;
      }

      const fn = resolvedFns.get(check)!;
      try {
        const fnResult = await fn(file.text);
        results[check] = fnResult as ScanCheckResult;
      } catch (err) {
        console.error(`Scan check "${check}" failed for ${file.path}:`, err);
      }
    }

    fileResults.push({ path: file.path, results });
  }

  const response: ScanFilesResponse = {
    files: fileResults,
    tier: auth.tier,
    checks_run: checksRun,
    checks_skipped: checksSkipped,
  };

  return c.json(response);
}
