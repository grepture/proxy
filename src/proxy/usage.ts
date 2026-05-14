export type UsageInfo = {
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  model: string | null;
  provider: string | null;
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
 * find the last `data: {...}` line that contains usage info.
 * For buffered responses, parse as plain JSON.
 */
function parseResponseData(body: string): unknown {
  // Try direct JSON parse first (buffered response)
  try {
    return JSON.parse(body);
  } catch {
    // Not valid JSON — try SSE format
  }

  // Streaming: find the last data line with usage info
  const lines = body.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") continue;
    try {
      const parsed = JSON.parse(payload);
      if (hasUsageData(parsed)) return parsed;
    } catch {
      continue;
    }
  }

  return null;
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

  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: asNumber(usage.total_tokens) ?? sum(prompt, completion),
    model: asString(obj.model) ?? asString(responseObj?.model),
    provider: "openai",
  };
}

function extractAnthropic(obj: Record<string, unknown>): UsageInfo | null {
  // Anthropic non-streaming: usage at top level
  // Anthropic streaming: final message_delta event has usage
  const usage = (obj.usage as Record<string, unknown> | undefined) ?? null;
  if (!usage || typeof usage !== "object") return null;
  const input = asNumber(usage.input_tokens);
  const output = asNumber(usage.output_tokens);
  if (input === null && output === null) return null;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: sum(input, output),
    model: asString(obj.model),
    provider: "anthropic",
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
