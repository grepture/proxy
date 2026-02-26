import type { Context } from "hono";
import { getProviders } from "../providers";
import { detectPii } from "../pii/detector";
import type { PiiCategory, AuthInfo } from "../types";
import { getScanFn } from "./registry";
import type {
  ScanCheck,
  ScanFilesRequest,
  ScanFilesResponse,
  ScanFileResult,
  ScanCheckResult,
  PiiResult,
  SkippedResult,
} from "./types";

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

  // Determine which checks this tier allows
  const allowedChecks = checksForTier(auth.tier);
  const checksRun: string[] = [];
  const checksSkipped: Array<{ check: string; reason: string }> = [];

  // Resolve tier gating once
  const effectiveChecks: ScanCheck[] = [];
  for (const check of body.checks) {
    if (!allowedChecks.has(check)) {
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

  // Track which checks actually ran
  for (const check of effectiveChecks) {
    checksRun.push(check);
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

    for (const check of effectiveChecks) {
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

      // AI checks via scan registry
      const scanFn = getScanFn(check);
      if (!scanFn) {
        // Don't add to results — check is just unavailable
        continue;
      }

      try {
        const fnResult = await scanFn(file.text);
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
