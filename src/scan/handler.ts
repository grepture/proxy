import type { Context } from "hono";
import { getProviders } from "../providers";
import { detectPii } from "../pii/detector";
import type { PiiCategory, AuthInfo } from "../types";
import { getScanFn } from "./registry";
import type {
  ScanCheck,
  ScanRequest,
  ScanResponse,
  ScanCheckResult,
  PiiResult,
  ClassificationResult,
  SkippedResult,
  AccountResponse,
} from "./types";

const ALL_CHECKS: ScanCheck[] = ["pii", "ai_pii", "toxicity", "injection", "dlp", "compliance"];

const PRO_CHECKS: Set<ScanCheck> = new Set(["pii", "ai_pii"]);

const BUSINESS_CHECKS: Set<ScanCheck> = new Set(ALL_CHECKS);

const AI_CHECKS: Set<ScanCheck> = new Set(["ai_pii", "toxicity", "injection", "dlp", "compliance"]);

const MAX_TEXT_BYTES = 10_240; // 10KB

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
      // Free tier gets same checks as pro, but AI is subject to sampling
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

export async function scanHandler(c: Context): Promise<Response> {
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
  let body: ScanRequest;
  try {
    body = await c.req.json<ScanRequest>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text is required and must be a string" }, 400);
  }

  if (new TextEncoder().encode(body.text).length > MAX_TEXT_BYTES) {
    return c.json({ error: "text exceeds 10KB limit" }, 400);
  }

  if (!Array.isArray(body.checks) || body.checks.length === 0) {
    return c.json({ error: "checks must be a non-empty array" }, 400);
  }

  const invalidChecks = body.checks.filter((ch) => !ALL_CHECKS.includes(ch));
  if (invalidChecks.length > 0) {
    return c.json({ error: `Invalid checks: ${invalidChecks.join(", ")}` }, 400);
  }

  // Determine which checks this tier allows
  const allowedChecks = checksForTier(auth.tier);
  const results: Record<string, ScanCheckResult> = {};
  const checksRun: string[] = [];
  const checksSkipped: string[] = [];

  // Check AI sampling for free tier
  let aiQuotaExceeded = false;
  if (auth.tier === "free") {
    const hasAiChecks = body.checks.some((ch) => AI_CHECKS.has(ch));
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

  for (const check of body.checks) {
    // Tier gating
    if (!allowedChecks.has(check)) {
      const reason = PRO_CHECKS.has(check) ? "requires_pro" : "requires_business";
      results[check] = { skipped: true, reason } as SkippedResult;
      checksSkipped.push(check);
      continue;
    }

    // AI quota check for free tier
    if (aiQuotaExceeded && AI_CHECKS.has(check)) {
      results[check] = { skipped: true, reason: "ai_quota_exceeded" } as SkippedResult;
      checksSkipped.push(check);
      continue;
    }

    if (check === "pii") {
      // Built-in regex PII detection
      const matches = detectPii(body.text, PII_CATEGORIES);
      results.pii = {
        matches: matches.map((m) => ({
          category: m.category,
          match: m.match,
          start: m.start,
          end: m.end,
        })),
      } as PiiResult;
      checksRun.push("pii");
      continue;
    }

    // AI checks via scan registry
    const scanFn = getScanFn(check);
    if (!scanFn) {
      results[check] = { skipped: true, reason: "requires_business" } as SkippedResult;
      checksSkipped.push(check);
      continue;
    }

    try {
      const fnResult = await scanFn(body.text);
      results[check] = fnResult as ScanCheckResult;
      checksRun.push(check);
    } catch (err) {
      console.error(`Scan check "${check}" failed:`, err);
      results[check] = { skipped: true, reason: "requires_business" } as SkippedResult;
      checksSkipped.push(check);
    }
  }

  const response: ScanResponse = {
    results,
    tier: auth.tier,
    checks_run: checksRun,
    checks_skipped: checksSkipped,
  };

  return c.json(response);
}

export async function accountHandler(c: Context): Promise<Response> {
  const result = await authenticate(c);
  if ("error" in result) return result.error;
  const { auth } = result;

  const allowed = checksForTier(auth.tier);
  const checksAvailable = ALL_CHECKS.filter((ch) => allowed.has(ch));
  const checksUnavailable = ALL_CHECKS.filter((ch) => !allowed.has(ch));

  const response: AccountResponse = {
    tier: auth.tier,
    team_id: auth.team_id,
    checks_available: checksAvailable,
    checks_unavailable: checksUnavailable,
  };

  return c.json(response);
}
