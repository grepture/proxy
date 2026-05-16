export type UsageInfo = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  model: string | null;
  provider: string | null;
  // Provider prompt-caching breakouts. These are subsets of input billed at
  // different rates — never additive to prompt_tokens.
  //   Anthropic: usage.cache_read_input_tokens (disjoint with input_tokens)
  //              usage.cache_creation_input_tokens (disjoint with input_tokens)
  //   OpenAI:    usage.prompt_tokens_details.cached_tokens (subset of prompt_tokens)
  // See `proxy/src/pricing.ts` for how these are priced.
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
};

export function extractUsage(
  responseBody: string,
  targetUrl: string,
): UsageInfo | null {
  try {
    const provider = detectProvider(targetUrl);
    const data = parseResponseData(responseBody);
    if (!data) return null;

    if (provider) {
      const result = extractForProvider(data, provider);
      if (result) return result;
    }

    // Fallback: try all providers
    for (const p of ["openai", "anthropic", "gemini"] as const) {
      const result = extractForProvider(data, p);
      if (result) return result;
    }

    return null;
  } catch {
    return null;
  }
}

export function detectProvider(
  targetUrl: string,
): "openai" | "anthropic" | "gemini" | null {
  try {
    const host = new URL(targetUrl).hostname;
    if (host.includes("openai.com")) return "openai";
    if (host.includes("anthropic.com")) return "anthropic";
    if (host.includes("googleapis.com")) return "gemini";
    return null;
  } catch {
    return null;
  }
}

/**
 * Parse the response body. For streaming responses (concatenated SSE chunks),
 * find the latest event with usage info and merge in fields from earlier
 * events that the latest event omits — notably Anthropic's `message_start`,
 * which carries `model` and `input_tokens` (the final `message_delta` only
 * has `output_tokens`).
 * For buffered responses, parse as plain JSON.
 */
function parseResponseData(body: string): unknown {
  // Try direct JSON parse first (buffered response)
  try {
    return JSON.parse(body);
  } catch {
    // Not valid JSON — try SSE format
  }

  const events: Record<string, unknown>[] = [];
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const payload = trimmed.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === "object") {
        events.push(parsed as Record<string, unknown>);
      }
    } catch {
      continue;
    }
  }

  // Latest event with usage info — the canonical token totals live here.
  let latest: Record<string, unknown> | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    if (hasUsageData(events[i])) {
      latest = events[i];
      break;
    }
  }
  if (!latest) return null;

  // Anthropic merge: `message_start` event holds model + input_tokens (plus
  // cache_read/cache_creation breakouts when prompt caching is active) that
  // `message_delta` omits. Copy them onto the latest event if missing.
  for (const ev of events) {
    if (ev.type !== "message_start") continue;
    const msg = ev.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    if (msg.model && !latest.model) latest.model = msg.model;
    const msgUsage = msg.usage as Record<string, unknown> | undefined;
    const latestUsage = latest.usage as Record<string, unknown> | undefined;
    if (msgUsage && latestUsage) {
      for (const key of [
        "input_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
      ]) {
        if (msgUsage[key] != null && latestUsage[key] == null) {
          latestUsage[key] = msgUsage[key];
        }
      }
    }
    break;
  }

  return latest;
}

function hasUsageData(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;
  const obj = data as Record<string, unknown>;
  if (obj.usage || obj.usageMetadata) return true;
  // Responses API streaming nests usage inside the response object
  // on the final `response.completed` event.
  const response = obj.response as Record<string, unknown> | undefined;
  return !!(response && typeof response === "object" && response.usage);
}

function extractForProvider(
  data: unknown,
  provider: "openai" | "anthropic" | "gemini",
): UsageInfo | null {
  if (!data || typeof data !== "object") return null;
  const obj = data as Record<string, unknown>;

  switch (provider) {
    case "openai":
      return extractOpenAI(obj);
    case "anthropic":
      return extractAnthropic(obj);
    case "gemini":
      return extractGemini(obj);
  }
}

function extractOpenAI(obj: Record<string, unknown>): UsageInfo | null {
  // Responses API nests usage and model under `response` on the streaming
  // `response.completed` event; buffered Responses bodies have them at top
  // level (same as Chat Completions). Try both.
  const responseObj = obj.response as Record<string, unknown> | undefined;
  const usage = (obj.usage ?? responseObj?.usage) as
    | Record<string, unknown>
    | undefined;
  if (!usage || typeof usage !== "object") return null;

  // Chat Completions: prompt_tokens / completion_tokens
  // Responses API:    input_tokens  / output_tokens
  const prompt = asNumber(usage.prompt_tokens) ?? asNumber(usage.input_tokens);
  const completion =
    asNumber(usage.completion_tokens) ?? asNumber(usage.output_tokens);
  if (prompt === null && completion === null) return null;

  // Cached input is a subset of prompt_tokens, billed at 50% on Chat
  // Completions and Responses API alike.
  const promptDetails = (usage.prompt_tokens_details ??
    usage.input_tokens_details) as Record<string, unknown> | undefined;
  const cacheRead = promptDetails
    ? asNumber(promptDetails.cached_tokens)
    : null;

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: asNumber(usage.total_tokens) ?? sum(prompt, completion),
    model: asString(obj.model) ?? asString(responseObj?.model),
    provider: "openai",
    cache_read_tokens: cacheRead,
    cache_write_tokens: null,
  };
}

function extractAnthropic(obj: Record<string, unknown>): UsageInfo | null {
  // Anthropic non-streaming: usage at top level
  // Anthropic streaming: final message_delta event has usage; parseResponseData
  // merges model + input_tokens from the earlier message_start event onto it.
  const usage = (obj.usage as Record<string, unknown> | undefined) ?? null;
  if (!usage || typeof usage !== "object") return null;
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  // Cache fields are disjoint from input_tokens on Anthropic — billed at
  // 10% (read) and 125% (write) of the input rate respectively.
  const cacheRead = asNumber(usage.cache_read_input_tokens);
  const cacheWrite = asNumber(usage.cache_creation_input_tokens);
  if (input === null && output === null && cacheRead === null && cacheWrite === null) {
    return null;
  }
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: sum(input, output),
    model: asString(obj.model),
    provider: "anthropic",
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

function extractGemini(obj: Record<string, unknown>): UsageInfo | null {
  const meta = obj.usageMetadata as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") return null;
  const prompt = asNumber(meta.promptTokenCount);
  const candidates = asNumber(meta.candidatesTokenCount);
  if (prompt === null && candidates === null) return null;
  return {
    prompt_tokens: prompt,
    completion_tokens: candidates,
    total_tokens: asNumber(meta.totalTokenCount) ?? sum(prompt, candidates),
    model: asString(obj.modelVersion),
    provider: "gemini",
    cache_read_tokens: asNumber(meta.cachedContentTokenCount),
    cache_write_tokens: null,
  };
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function sum(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}
