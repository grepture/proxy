import type { Context } from "hono";
import { getProviders } from "./providers";
import { detectPii, type PiiMatch } from "./pii/detector";
import { replacePii } from "./pii/replacer";
import { getAction } from "./actions/registry";
import type { AuthInfo, EmbeddingLogEntry, PiiCategory } from "./types";

const REGEX_PII_CATEGORIES: PiiCategory[] = [
  "email", "phone", "ssn", "credit_card", "ip_address", "address", "date_of_birth",
];

const PRO_TIERS = new Set(["pro", "business", "custom"]);

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";

type RedactionStrategy = "placeholder" | "hash" | "mask";

type EmbeddingsBody = {
  model?: unknown;
  input?: unknown;
  dimensions?: unknown;
  encoding_format?: unknown;
  user?: unknown;
};

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

function parseStrategy(value: string | undefined): RedactionStrategy {
  if (value === "hash" || value === "mask") return value;
  return "placeholder";
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function looksTokenized(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.some((x) => typeof x === "number" || (Array.isArray(x) && x.every((y) => typeof y === "number")));
}

async function runAiPii(text: string): Promise<PiiMatch[]> {
  const action = getAction("ai_detect_pii");
  if (!action?.scan) return [];
  try {
    const result = (await action.scan(text)) as { matches?: PiiMatch[] };
    return Array.isArray(result?.matches) ? result.matches : [];
  } catch (err) {
    console.error("AI PII scan failed:", err);
    return [];
  }
}

function mergeMatches(a: PiiMatch[], b: PiiMatch[]): PiiMatch[] {
  if (b.length === 0) return a;
  const merged = [...a, ...b];
  merged.sort((m1, m2) => m1.start - m2.start || m2.end - m1.end);
  const deduped: PiiMatch[] = [];
  let lastEnd = -1;
  for (const m of merged) {
    if (m.start >= lastEnd) {
      deduped.push(m);
      lastEnd = m.end;
    }
  }
  return deduped;
}

export async function embeddingsHandler(c: Context): Promise<Response> {
  const startedAt = performance.now();

  const authResult = await authenticate(c);
  if ("error" in authResult) return authResult.error;
  const { auth } = authResult;

  const providers = getProviders();

  // Rate / quota
  try {
    const rq = await providers.rateQuota.check(auth.team_id, auth.tier);
    if (!rq.rate.allowed) return c.json({ error: "Rate limit exceeded" }, 429);
    if (!rq.quota.allowed) return c.json({ error: "Monthly quota exceeded" }, 429);
  } catch (err) {
    console.error("Rate/quota check error:", err);
    // Fail open
  }

  let body: EmbeddingsBody;
  try {
    body = await c.req.json<EmbeddingsBody>();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.model !== "string" || body.model.length === 0) {
    return c.json({ error: "model is required and must be a string" }, 400);
  }

  if (looksTokenized(body.input)) {
    return c.json(
      {
        error: "tokenized_input_not_supported",
        message: "Grepture cannot redact PII from pre-tokenized input. Pass strings instead.",
      },
      400,
    );
  }

  let inputs: string[];
  let inputWasString = false;
  if (typeof body.input === "string") {
    inputs = [body.input];
    inputWasString = true;
  } else if (isStringArray(body.input)) {
    inputs = body.input;
  } else {
    return c.json({ error: "input must be a string or array of strings" }, 400);
  }

  if (inputs.length === 0) {
    return c.json({ error: "input must not be empty" }, 400);
  }

  const model = body.model;
  const dimensions = typeof body.dimensions === "number" ? body.dimensions : undefined;

  const strategy = parseStrategy(c.req.header("x-grepture-redaction-strategy"));
  const onPii = c.req.header("x-grepture-on-pii") === "block" ? "block" : "redact";
  const traceId = c.req.header("x-grepture-trace-id") || null;

  // --- Redact ---
  const useAi = PRO_TIERS.has(auth.tier);
  let totalRegex = 0;
  let totalAi = 0;
  const categoriesCaught = new Set<string>();
  const redactedInputs: string[] = [];
  let totalChars = 0;

  for (const text of inputs) {
    totalChars += text.length;

    const regexMatches = detectPii(text, REGEX_PII_CATEGORIES);
    const aiMatches = useAi ? await runAiPii(text) : [];

    totalRegex += regexMatches.length;
    totalAi += aiMatches.length;

    const all = mergeMatches(regexMatches, aiMatches);
    for (const m of all) categoriesCaught.add(m.category);

    if (all.length > 0 && onPii === "redact") {
      redactedInputs.push(await replacePii(text, all, strategy));
    } else {
      redactedInputs.push(text);
    }
  }

  const redactionCount = totalRegex + totalAi;
  const redactionSource: "regex" | "ai" | "both" | null =
    totalRegex > 0 && totalAi > 0 ? "both" : totalRegex > 0 ? "regex" : totalAi > 0 ? "ai" : null;
  const categoriesArr = Array.from(categoriesCaught);

  // Block mode short-circuit
  if (onPii === "block" && redactionCount > 0) {
    const duration = performance.now() - startedAt;
    providers.log.pushEmbedding({
      team_id: auth.team_id,
      trace_id: traceId,
      provider_key_id: null,
      byok: false,
      model,
      input_count: inputs.length,
      total_chars: totalChars,
      dimensions: dimensions ?? null,
      redaction_strategy: strategy,
      redaction_categories: categoriesArr,
      redaction_count: redactionCount,
      redaction_source: redactionSource,
      blocked: true,
      status_code: 422,
      tokens: null,
      duration_ms: Math.round(duration),
    });
    return c.json(
      { error: "pii_detected", categories: categoriesArr, count: redactionCount },
      422,
    );
  }

  // --- Resolve OpenAI key (BYOK header > stored provider_keys > error) ---
  const callerForward = c.req.header("x-grepture-auth-forward");
  let openaiKey: string | null = null;
  let providerKeyId: string | null = null;
  let byok = false;

  if (callerForward) {
    openaiKey = callerForward.startsWith("Bearer ") ? callerForward.slice(7) : callerForward;
    byok = true;
  } else {
    const resolved = await providers.providerKeys.resolve(auth.team_id, "openai").catch((err) => {
      console.error("Provider key resolve error:", err);
      return null;
    });
    if (resolved) {
      openaiKey = resolved.decrypted;
      providerKeyId = resolved.id;
    }
  }

  if (!openaiKey) {
    return c.json(
      {
        error: "no_openai_key",
        message:
          "Provide an OpenAI key via the X-Grepture-Auth-Forward header or configure one in Grepture > Integrations > Provider Keys.",
      },
      400,
    );
  }

  // --- Forward to OpenAI ---
  const forwardBody: Record<string, unknown> = {
    model,
    input: inputWasString ? redactedInputs[0] : redactedInputs,
  };
  if (dimensions !== undefined) forwardBody.dimensions = dimensions;
  if (typeof body.encoding_format === "string") forwardBody.encoding_format = body.encoding_format;
  if (typeof body.user === "string") forwardBody.user = body.user;

  let upstreamStatus = 0;
  let upstreamText = "";
  let upstreamTokens: number | null = null;
  try {
    const upstream = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(forwardBody),
    });
    upstreamStatus = upstream.status;
    upstreamText = await upstream.text();
    try {
      const parsed = JSON.parse(upstreamText) as { usage?: { prompt_tokens?: number; total_tokens?: number } };
      upstreamTokens = parsed?.usage?.total_tokens ?? parsed?.usage?.prompt_tokens ?? null;
    } catch {
      // Non-JSON response from upstream (e.g. error page) — keep status as-is
    }
  } catch (err) {
    console.error("Embedding forward failed:", err);
    upstreamStatus = 502;
    upstreamText = JSON.stringify({ error: "upstream_unreachable" });
  }

  const duration = performance.now() - startedAt;

  providers.log.pushEmbedding({
    team_id: auth.team_id,
    trace_id: traceId,
    provider_key_id: providerKeyId,
    byok,
    model,
    input_count: inputs.length,
    total_chars: totalChars,
    dimensions: dimensions ?? null,
    redaction_strategy: strategy,
    redaction_categories: categoriesArr,
    redaction_count: redactionCount,
    redaction_source: redactionSource,
    blocked: false,
    status_code: upstreamStatus,
    tokens: upstreamTokens,
    duration_ms: Math.round(duration),
  });

  return new Response(upstreamText, {
    status: upstreamStatus,
    headers: {
      "Content-Type": "application/json",
      "x-grepture-redactions": String(redactionCount),
      "x-grepture-pii-categories": categoriesArr.join(","),
    },
  });
}
