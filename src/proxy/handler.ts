import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { getProviders } from "../providers";
import { filterRules } from "../rules/filter";
import { matchRules } from "../rules/matcher";
import { runPipeline, type PipelineResult } from "../actions/pipeline";
import { forwardRequest, type ForwardResult } from "./forward";
import { forwardWithFallback } from "./forward-with-fallback";
import { extractUsage, detectProvider, type UsageInfo } from "./usage";
import { detokenize } from "../actions/tokenize";
import { createDetokenizeStream } from "./detokenize-stream";
import { createResponsesToChatStream } from "./responses-to-chat-stream";
import { config } from "../config";
import { detectPii } from "../pii/detector";
import { replacePii } from "../pii/replacer";
import type { RequestContext, TokenizeAction, TrafficLogEntry, AuthInfo, PiiCategory, RedactPiiAction, AiDetectPiiAction, PromptMessage } from "../types";
import { fetchPrompt } from "../prompts/cache";
import { resolveMessages } from "../prompts/resolver";

export async function proxyHandler(c: Context): Promise<Response> {
  const startedAt = performance.now();
  const requestId = (c.get("requestId" as never) as string) || crypto.randomUUID();
  const providers = getProviders();

  // --- Auth ---
  const authHeader = c.req.header("authorization") || "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!apiKey) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  let auth: AuthInfo | null;
  try {
    auth = await providers.auth.authenticate(apiKey);
  } catch (err) {
    console.error("Auth error:", err);
    return c.json({ error: "Authentication service error" }, 500);
  }

  if (!auth) {
    return c.json({ error: "Invalid API key" }, 401);
  }

  // --- Target URL (synchronous — do before async work) ---
  const targetUrl = c.req.header("x-grepture-target") || (c.get("injectedTarget" as never) as string | undefined);
  if (!targetUrl) {
    return c.json({ error: "Missing X-Grepture-Target header" }, 400);
  }

  try {
    new URL(targetUrl);
  } catch {
    return c.json({ error: "Invalid X-Grepture-Target URL" }, 400);
  }

  // --- Kick off parallel work (all need auth, none depend on each other) ---
  const rateQuotaPromise = providers.rateQuota
    .check(auth.team_id, auth.tier)
    .catch((err: unknown) => {
      console.error("Rate/quota check error:", err);
      return null; // Fail open
    });

  const rulesPromise = providers.rules.loadRules(auth.team_id);

  // Provider key resolution: only fetch if the caller didn't supply one explicitly.
  // The user-supplied X-Grepture-Auth-Forward header always wins.
  // We resolve the entire fallback chain so the forward step can retry on 5xx.
  const callerSuppliedAuthForward = c.req.header("x-grepture-auth-forward");
  const detectedProvider = callerSuppliedAuthForward ? null : detectProvider(targetUrl);
  const providerKeyChainPromise = detectedProvider
    ? providers.providerKeys.resolveChain(auth.team_id, detectedProvider).catch((err: unknown) => {
        console.error("Provider key chain resolve error:", err);
        return [] as Awaited<ReturnType<typeof providers.providerKeys.resolveChain>>;
      })
    : Promise.resolve([] as Awaited<ReturnType<typeof providers.providerKeys.resolveChain>>);

  const injectedBody = c.get("injectedBody" as never) as string | undefined;
  const bodyPromise = injectedBody
    ? Promise.resolve((() => {
        let parsedBody: unknown = null;
        try { parsedBody = JSON.parse(injectedBody); } catch { /* not JSON */ }
        return { error: null, body: injectedBody, parsedBody };
      })())
    : c.req.arrayBuffer().then((raw) => {
        if (raw.byteLength > config.maxBodySize) {
          return { error: "Request body too large (max 10MB)" as const, body: "", parsedBody: null as unknown };
        }
        const body = new TextDecoder().decode(raw);
        let parsedBody: unknown = null;
        try { parsedBody = JSON.parse(body); } catch { /* not JSON */ }
        return { error: null, body, parsedBody };
      }).catch(() => ({ error: null, body: "", parsedBody: null as unknown }));

  // Rate+quota, body, and provider key chain can resolve independently; rules may throw (handled in try below)
  const [rateQuota, bodyResult, providerKeyChain] = await Promise.all([
    rateQuotaPromise,
    bodyPromise,
    providerKeyChainPromise,
  ]);

  // --- Check rate limit result ---
  if (rateQuota) {
    if (!rateQuota.rate.allowed) {
      if (rateQuota.rate.retryAfter) c.header("Retry-After", String(rateQuota.rate.retryAfter));
      if (rateQuota.rate.limit) c.header("X-RateLimit-Limit", String(rateQuota.rate.limit));
      c.header("X-RateLimit-Remaining", "0");
      return c.json(
        { error: "Rate limit exceeded. Please slow down." },
        429,
      );
    }
    if (!rateQuota.quota.allowed) {
      return c.json(
        { error: "Monthly request quota exceeded. Please upgrade." },
        429,
      );
    }
  }

  // --- Check body parse result ---
  if (bodyResult.error) {
    return c.json({ error: bodyResult.error }, 413);
  }

  const body = bodyResult.body;
  const parsedBody = bodyResult.parsedBody;

  // --- Detect streaming ---
  const streamingRequested =
    parsedBody !== null &&
    typeof parsedBody === "object" &&
    (parsedBody as Record<string, unknown>).stream === true;

  // --- Extract trace ID (optional, for conversation tracing) ---
  const traceId = c.req.header("x-grepture-trace-id") || null;

  // --- Extract label (optional, per-request identifier within a trace) ---
  const label = c.req.header("x-grepture-label") || null;

  // --- Extract metadata (optional, arbitrary key-value tags) ---
  const metadataHeader = c.req.header("x-grepture-metadata");
  let metadata: Record<string, string> | null = null;
  if (metadataHeader) {
    try { metadata = JSON.parse(metadataHeader); } catch { /* invalid JSON, ignore */ }
  }

  // --- Extract sequence number (optional, for ordering within a trace) ---
  const seqHeader = c.req.header("x-grepture-seq");
  const seq = seqHeader ? parseInt(seqHeader, 10) : null;

  // --- Extract session ID (optional, for dev session grouping) ---
  const sessionId = c.req.header("x-grepture-session-id") || null;

  // --- Build request context ---
  const headers: Record<string, string> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const ctx: RequestContext = {
    requestId,
    auth,
    method: c.req.method,
    targetUrl,
    headers,
    body,
    parsedBody,
    startedAt,
    traceId,
    label,
    metadata,
    seq,
    sessionId,
  };

  // --- Inject stored provider key if no header was supplied ---
  // We inject the primary key (first in chain) here for rules/pipeline access. The
  // forward step uses the full chain via forwardWithFallback for automatic failover.
  // The invariant for x-grepture-auth-forward is `Bearer <key>` (forward.ts strips
  // the prefix for Anthropic's x-api-key header).
  if (!callerSuppliedAuthForward) {
    if (providerKeyChain.length > 0) {
      ctx.headers["x-grepture-auth-forward"] = `Bearer ${providerKeyChain[0].decrypted}`;
    } else if (detectedProvider) {
      // We could detect the provider but no key is stored — caller must supply one
      return c.json(
        {
          error: `No ${detectedProvider} provider key found. Pass X-Grepture-Auth-Forward header or save a key in Settings.`,
        },
        401,
      );
    }
    // If detectedProvider is null (unknown target), fall through — request will likely
    // fail upstream unless the target accepts unauthenticated requests.
  }

  // --- Prompt resolution (before rules) ---
  let skipRules = false;
  let resolvedPromptId: string | null = null;
  let resolvedPromptVersion: number | null = null;
  const promptSlugHeader = c.req.header("x-grepture-prompt");
  if (promptSlugHeader) {
    // Parse "slug" or "slug@ref"
    const atIdx = promptSlugHeader.indexOf("@");
    const slug = atIdx >= 0 ? promptSlugHeader.slice(0, atIdx) : promptSlugHeader;
    const ref = atIdx >= 0 ? promptSlugHeader.slice(atIdx + 1) : undefined;

    const varsHeader = c.req.header("x-grepture-vars");
    let variables: Record<string, string> = {};
    if (varsHeader) {
      try {
        variables = JSON.parse(varsHeader);
      } catch {
        return c.json({ error: "Invalid X-Grepture-Vars JSON" }, 400);
      }
    }

    const resolved = await fetchPrompt(auth.team_id, slug, ref);
    if (!resolved) {
      return c.json({ error: `Prompt "${promptSlugHeader}" not found` }, 404);
    }

    resolvedPromptId = resolved.prompt.id;
    resolvedPromptVersion = resolved.version.version; // integer or null for draft

    // Resolve template
    const resolvedMessages = resolveMessages(resolved.version.messages, variables);

    // Replace messages in request body
    if (ctx.parsedBody && typeof ctx.parsedBody === "object") {
      const base = ctx.parsedBody as Record<string, unknown>;
      const newBody: Record<string, unknown> = { ...base, messages: resolvedMessages };
      ctx.body = JSON.stringify(newBody);
      ctx.parsedBody = newBody;
    }

    skipRules = resolved.prompt.skip_rules;
  }

  // --- Load and process INPUT rules ---
  let forwardResult: ForwardResult;
  let inputRulesApplied: string[] = [];
  let allTags: Array<{ severity: string; label: string }> = [];
  let logRedactCategories: PiiCategory[] = [];
  let aiSampling: { used: number; limit: number } | undefined;
  // The actual provider key used for the upstream call (may differ from primary on fallback).
  // Default to the primary key if we have a chain — overridden by forwardWithFallback's result.
  let providerKeyIdUsed: string | null = providerKeyChain[0]?.id ?? null;

  try {
    // Await rules (already started in parallel above)
    const allRules = await rulesPromise;

    // Input rules (skip if prompt has skip_rules enabled)
    const inputRules = skipRules ? [] : filterRules(allRules, "input");
    const matchedInput = skipRules ? [] : matchRules(ctx, inputRules);

    if (matchedInput.length > 0) {
      const inputResult = await runPipeline(ctx, matchedInput, providers.vault, providers.quota);
      inputRulesApplied = inputResult.rulesApplied;
      allTags.push(...inputResult.tags);
      if (inputResult.aiSampling) aiSampling = inputResult.aiSampling;

      if (inputResult.blocked) {
        const duration = performance.now() - startedAt;
        logTraffic(providers.log, ctx, inputResult.statusCode || 403, duration, inputRulesApplied, "", {}, null, body, resolvedPromptId, resolvedPromptVersion, providerKeyIdUsed);
        return c.json(
          { error: inputResult.message || "Request blocked" },
          (inputResult.statusCode || 403) as ContentfulStatusCode,
        );
      }
    }

    // Inject stream_options for OpenAI streaming so usage data appears in the
    // final SSE chunk. Without this, extractUsage finds nothing and tokens log as 0.
    if (streamingRequested && detectProvider(ctx.targetUrl) === "openai") {
      const parsed = ctx.parsedBody as Record<string, unknown> | null;
      if (parsed && !parsed.stream_options) {
        parsed.stream_options = { include_usage: true };
        ctx.parsedBody = parsed;
        ctx.body = JSON.stringify(parsed);
      }
    }

    // --- Forward ---
    const timeoutMs = Math.min(
      ...allRules
        .filter((r) => inputRulesApplied.includes(r.id))
        .map((r) => r.timeout_seconds * 1000)
        .concat([60_000]),
    );

    // Use forwardWithFallback when we have a stored key chain (enables automatic
    // failover on 5xx). When the caller supplied their own key, use the simple path.
    if (!callerSuppliedAuthForward && providerKeyChain.length > 0) {
      const fallbackResult = await forwardWithFallback(ctx, providerKeyChain, timeoutMs, streamingRequested);
      providerKeyIdUsed = fallbackResult.keyIdUsed;
      forwardResult = fallbackResult;
    } else {
      forwardResult = await forwardRequest(ctx, timeoutMs, streamingRequested);
    }
    logRedactCategories = collectMaskRestoreCategories(allRules);

    // --- Streaming path ---
    if (forwardResult.mode === "streaming") {
      const tokenizePrefixes = collectTokenPrefixes(allRules, inputRulesApplied);
      const translateResponsesToChat = c.get("translateResponsesToChat" as never) as boolean | undefined;

      const upstreamBody = translateResponsesToChat
        ? createResponsesToChatStream(forwardResult.rawBody)
        : forwardResult.rawBody;

      const { stream, accumulated } = createDetokenizeStream(
        upstreamBody,
        auth.team_id,
        tokenizePrefixes,
        providers.vault,
      );

      // Build response headers
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(forwardResult.headers)) {
        if (["transfer-encoding", "connection", "keep-alive", "content-encoding", "content-length"].includes(key.toLowerCase())) continue;
        responseHeaders.set(key, value);
      }
      responseHeaders.set("x-request-id", requestId);
      responseHeaders.set("x-grepture-rules-applied", inputRulesApplied.join(","));
      // Required for SSE: prevent buffering by clients and intermediaries
      responseHeaders.set("cache-control", "no-cache");
      responseHeaders.set("x-accel-buffering", "no");
      if (aiSampling && aiSampling.limit !== Infinity) {
        responseHeaders.set("x-grepture-ai-sampling", `${aiSampling.used}/${aiSampling.limit}`);
      }

      // Fire-and-forget: log after stream completes, re-redacting PII
      accumulated.then(async (fullBody) => {
        const logBody = await redactForLog(fullBody, logRedactCategories);
        const usage = extractUsage(fullBody, ctx.targetUrl);
        const duration = performance.now() - startedAt;
        logTraffic(providers.log, ctx, forwardResult.status, duration, inputRulesApplied, logBody, forwardResult.headers, usage, body, resolvedPromptId, resolvedPromptVersion, providerKeyIdUsed);
      }).catch((err) => {
        console.error(`Streaming log error [${requestId}]:`, err);
      });

      return new Response(stream, {
        status: forwardResult.status,
        headers: responseHeaders,
      });
    }

    // --- Buffered path (unchanged) ---

    // --- Output rules ---
    const outputRules = skipRules ? [] : filterRules(allRules, "output");

    // Build a response-oriented context for matching
    const responseCtx: RequestContext = {
      ...ctx,
      body: forwardResult.body,
      parsedBody: tryParse(forwardResult.body),
      headers: forwardResult.headers,
    };

    const matchedOutput = matchRules(responseCtx, outputRules);

    if (matchedOutput.length > 0) {
      const outputResult = await runPipeline(responseCtx, matchedOutput, providers.vault, providers.quota);
      inputRulesApplied.push(...outputResult.rulesApplied);
      allTags.push(...outputResult.tags);
      if (outputResult.aiSampling) aiSampling = outputResult.aiSampling;

      // Update forward result with mutated body
      forwardResult.body = responseCtx.body;
    }

    // --- Detokenize ---
    const tokenizePrefixes = collectTokenPrefixes(allRules, inputRulesApplied);
    if (tokenizePrefixes.length > 0) {
      forwardResult.body = await detokenize(
        forwardResult.body,
        auth.team_id,
        tokenizePrefixes,
        providers.vault,
      );
    }
  } catch (err) {
    console.error(`Proxy error [${requestId}]:`, err);
    const duration = performance.now() - startedAt;

    if (auth.fallback_mode === "passthrough") {
      // Forward raw request to target
      forwardResult = await forwardRequest(
        { ...ctx, body, parsedBody },
        60_000,
      );
    } else {
      logTraffic(providers.log, ctx, 502, duration, inputRulesApplied, "", {}, null, body, resolvedPromptId, resolvedPromptVersion, providerKeyIdUsed);
      return c.json({ error: "Proxy processing error" }, 502);
    }
  }

  // --- Log (re-redact PII from mask & restore before saving) ---
  const duration = performance.now() - startedAt;
  const rawLogBody = forwardResult.mode === "buffered" ? forwardResult.body : "";
  const logBody = await redactForLog(rawLogBody, logRedactCategories);
  const usage = rawLogBody ? extractUsage(rawLogBody, ctx.targetUrl) : null;
  logTraffic(
    providers.log,
    ctx,
    forwardResult.status,
    duration,
    inputRulesApplied,
    logBody,
    forwardResult.headers,
    usage,
    body,
    resolvedPromptId,
    resolvedPromptVersion,
    providerKeyIdUsed,
  );

  // --- Return response ---
  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(forwardResult.headers)) {
    // Skip hop-by-hop headers
    if (["transfer-encoding", "connection", "keep-alive", "content-encoding", "content-length"].includes(key.toLowerCase())) continue;
    responseHeaders.set(key, value);
  }
  responseHeaders.set("x-request-id", requestId);

  responseHeaders.set("x-grepture-rules-applied", inputRulesApplied.join(","));
  if (aiSampling && aiSampling.limit !== Infinity) {
    responseHeaders.set("x-grepture-ai-sampling", `${aiSampling.used}/${aiSampling.limit}`);
  }

  return new Response(forwardResult.mode === "buffered" ? forwardResult.body : "", {
    status: forwardResult.status,
    headers: responseHeaders,
  });
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function collectTokenPrefixes(allRules: Array<{ actions: Array<{ type: string; enabled: boolean }> }>, appliedIds: string[]): string[] {
  const prefixes: string[] = [];
  for (const rule of allRules) {
    for (const action of rule.actions) {
      if (action.type === "tokenize" && action.enabled) {
        prefixes.push((action as unknown as TokenizeAction).token_prefix);
      }
      if (action.type === "redact_pii" && action.enabled) {
        const piiAction = action as unknown as RedactPiiAction;
        if (piiAction.mode === "mask_and_restore" && piiAction.token_prefix) {
          prefixes.push(piiAction.token_prefix);
        }
      }
      if (action.type === "ai_detect_pii" && action.enabled) {
        const aiPiiAction = action as unknown as AiDetectPiiAction;
        if (aiPiiAction.mode === "mask_and_restore" && aiPiiAction.token_prefix) {
          prefixes.push(aiPiiAction.token_prefix);
        }
      }
    }
  }
  return [...new Set(prefixes)];
}

function collectMaskRestoreCategories(allRules: Array<{ actions: Array<{ type: string; enabled: boolean }> }>): PiiCategory[] {
  const categories: PiiCategory[] = [];
  for (const rule of allRules) {
    for (const action of rule.actions) {
      if (action.type === "redact_pii" && action.enabled) {
        const a = action as unknown as RedactPiiAction;
        if (a.mode === "mask_and_restore") categories.push(...a.categories);
      }
      if (action.type === "ai_detect_pii" && action.enabled) {
        const a = action as unknown as AiDetectPiiAction;
        if (a.mode === "mask_and_restore") {
          // Map AI categories to regex PII categories for best-effort re-redaction
          // (NER categories like "person" don't have regex equivalents, but "name" does)
          const map: Record<string, PiiCategory> = { person: "name" };
          for (const cat of a.categories) {
            if (cat in map) categories.push(map[cat]);
          }
        }
      }
    }
  }
  return [...new Set(categories)];
}

async function redactForLog(body: string, categories: PiiCategory[]): Promise<string> {
  if (categories.length === 0) return body;
  const matches = detectPii(body, categories);
  if (matches.length === 0) return body;
  return replacePii(body, matches, "placeholder");
}

function redactKey(value: string): string {
  // "Bearer sk-abc123xyz" → "Bearer sk-abc...xyz"
  const stripped = value.replace(/^Bearer\s+/i, "");
  if (stripped.length <= 8) return "***";
  return `${stripped.slice(0, 4)}...${stripped.slice(-4)}`;
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === "x-grepture-auth-forward" || lower === "authorization") {
      out[key] = redactKey(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    return `${host[0]}${"*".repeat(Math.max(host.length - 5, 1))}.${host.split(".").pop()}`;
  } catch {
    return "***";
  }
}

import type { LogWriter } from "../providers/types";

function logTraffic(
  log: LogWriter,
  ctx: RequestContext,
  statusCode: number,
  durationMs: number,
  rulesApplied: string[],
  responseBody: string,
  responseHeaders: Record<string, string>,
  usage: UsageInfo | null,
  originalBody?: string,
  promptId?: string | null,
  promptVersion?: number | null,
  providerKeyId?: string | null,
): void {
  const zeroData = ctx.auth.zero_data_mode;

  // Only store original body if it differs from the (possibly mutated) request body
  const origDiffers = originalBody && originalBody !== ctx.body;

  const entry: TrafficLogEntry = {
    user_id: ctx.auth.user_id,
    team_id: ctx.auth.team_id,
    method: ctx.method,
    target_url: zeroData ? redactUrl(ctx.targetUrl) : ctx.targetUrl,
    status_code: statusCode,
    rules_applied: rulesApplied,
    duration_ms: Math.round(durationMs),
    request_headers: zeroData ? {} : redactHeaders(ctx.headers),
    request_body: zeroData ? "" : ctx.body.slice(0, 50_000),
    response_headers: zeroData ? {} : responseHeaders,
    response_body: zeroData ? "" : responseBody.slice(0, 50_000),
    prompt_tokens: usage?.prompt_tokens ?? null,
    completion_tokens: usage?.completion_tokens ?? null,
    total_tokens: usage?.total_tokens ?? null,
    model: usage?.model ?? null,
    provider: usage?.provider ?? null,
    original_request_body: zeroData ? null : (origDiffers ? originalBody!.slice(0, 50_000) : null),
    trace_id: ctx.traceId,
    label: ctx.label,
    metadata: ctx.metadata,
    seq: ctx.seq,
    session_id: ctx.sessionId,
    prompt_id: promptId ?? null,
    prompt_version: promptVersion ?? null,
    provider_key_id: providerKeyId ?? null,
  };

  log.push(entry);
}
