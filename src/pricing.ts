// Proxy-side pricing. Mirrors app/lib/model-pricing.ts — keep them in sync.
// TODO: extract to a shared JSON file consumed by both packages.
//
// Used by recordBudgetSpend after each forwarded request to INCRBY the
// :spent: counter. App-side `estimateCost` re-derives the same number on the
// cron path from traffic_logs rows (which include cache token columns).

export type ModelPrice = {
  input: number;
  output: number;
  cache_read_rate?: number;
  cache_write_rate?: number;
};

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // OpenAI — cache_read = input × 0.50
  "gpt-5-mini":    { input: 0.25,  output: 2.00,  cache_read_rate: 0.125 },
  "gpt-4o":        { input: 2.50,  output: 10.00, cache_read_rate: 1.25  },
  "gpt-4o-mini":   { input: 0.15,  output: 0.60,  cache_read_rate: 0.075 },
  "gpt-4.1":       { input: 2.00,  output: 8.00,  cache_read_rate: 1.00  },
  "gpt-4.1-mini":  { input: 0.40,  output: 1.60,  cache_read_rate: 0.20  },
  "gpt-4.1-nano":  { input: 0.10,  output: 0.40,  cache_read_rate: 0.05  },
  "o3":            { input: 2.00,  output: 8.00,  cache_read_rate: 0.50  },
  "o3-mini":       { input: 1.10,  output: 4.40,  cache_read_rate: 0.55  },
  "o4-mini":       { input: 1.10,  output: 4.40,  cache_read_rate: 0.275 },
  // Anthropic — cache_read = input × 0.10, cache_write = input × 1.25
  "claude-opus-4-6":               { input: 15.00, output: 75.00, cache_read_rate: 1.50,  cache_write_rate: 18.75 },
  "claude-sonnet-4-6":             { input: 3.00,  output: 15.00, cache_read_rate: 0.30,  cache_write_rate: 3.75  },
  "claude-sonnet-4-5-20250514":    { input: 3.00,  output: 15.00, cache_read_rate: 0.30,  cache_write_rate: 3.75  },
  "claude-haiku-4-5-20251001":     { input: 1.00,  output: 5.00,  cache_read_rate: 0.10,  cache_write_rate: 1.25  },
  "claude-haiku-3-5-20241022":     { input: 0.80,  output: 4.00,  cache_read_rate: 0.08,  cache_write_rate: 1.00  },
  // Google — cache_read for Gemini context caching
  "gemini-2.5-pro":   { input: 1.25, output: 10.00, cache_read_rate: 0.3125 },
  "gemini-2.5-flash": { input: 0.15, output: 0.60,  cache_read_rate: 0.0375 },
};

function resolvePrice(model: string): ModelPrice | undefined {
  if (MODEL_PRICING[model]) return MODEL_PRICING[model];
  // OpenAI-style date suffix: gpt-4o-mini-2024-07-18 → gpt-4o-mini
  const stripOpenAi = model.replace(/-\d{4}-\d{2}-\d{2}$/, "");
  if (stripOpenAi !== model && MODEL_PRICING[stripOpenAi]) return MODEL_PRICING[stripOpenAi];
  // Anthropic-style date suffix: claude-haiku-3-5-20241022 → claude-haiku-3-5
  const stripAnthropic = model.replace(/-\d{8}$/, "");
  if (stripAnthropic !== model && MODEL_PRICING[stripAnthropic]) return MODEL_PRICING[stripAnthropic];
  return undefined;
}

function clamp(n: number | null | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return 0;
  return n;
}

function isCacheSubsetConvention(model: string): boolean {
  // OpenAI / Gemini report cached as a subset of prompt. Anthropic reports
  // cache_read / cache_creation as disjoint from input_tokens.
  return !model.toLowerCase().startsWith("claude");
}

/** Estimate cost in MICRO-cents (1 USD = 1,000,000 micro-cents = 100 cents). */
export function estimateCostMicroCents(
  model: string | null | undefined,
  promptTokens: number | null | undefined,
  completionTokens: number | null | undefined,
  cacheReadTokens?: number | null,
  cacheWriteTokens?: number | null,
): number {
  if (!model) return 0;
  const price = resolvePrice(model);
  if (!price) return 0;

  const prompt = clamp(promptTokens);
  const completion = clamp(completionTokens);
  const cacheRead = clamp(cacheReadTokens);
  const cacheWrite = clamp(cacheWriteTokens);

  const nonCachedInput = isCacheSubsetConvention(model)
    ? Math.max(prompt - cacheRead - cacheWrite, 0)
    : prompt;

  const cacheReadRate = price.cache_read_rate ?? price.input;
  const cacheWriteRate = price.cache_write_rate ?? price.input;

  const dollars =
    (nonCachedInput / 1_000_000) * price.input +
    (cacheRead      / 1_000_000) * cacheReadRate +
    (cacheWrite     / 1_000_000) * cacheWriteRate +
    (completion     / 1_000_000) * price.output;

  return Math.round(dollars * 100 * 10_000); // dollars → cents → micro-cents
}
