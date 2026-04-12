import type { RequestContext } from "../types";
import type { ResolvedProviderKey } from "../providers/types";
import { forwardRequest, type ForwardResult } from "./forward";
import { detectProvider } from "./usage";
import {
  translateRequest,
  translateResponse,
  createStreamingTranslator,
  providerUrl,
  TranslationNotSupportedError,
  type Format,
} from "../translation";

export type FallbackForwardResult = ForwardResult & { keyIdUsed: string | null };

/**
 * Status codes that should trigger a fallback attempt:
 * - 401: key revoked or invalid — another key might work
 * - 408: upstream request timeout
 * - 429: rate limited — another key might be on a different quota bucket
 * - 500-599: upstream server errors
 *
 * Explicitly NOT retried: 400 (malformed request — would fail on any key),
 * 403 (content policy or permission — key-specific issue that won't help),
 * 404 (model/endpoint not found), other 4xx.
 */
function shouldFallback(status: number): boolean {
  if (status === 401 || status === 408 || status === 429) return true;
  if (status >= 500) return true;
  return false;
}

/**
 * Try each key in the chain in order. If a key returns a 5xx response (server error
 * or gateway error), advance to the next key.
 *
 * Cross-provider fallback uses the translation module: the request body is
 * translated to the fallback provider's format, the target URL is updated, and
 * the response (or stream) is translated back to the original caller's format.
 *
 * Streaming caveat: once headers are sent to the caller, no retry is possible.
 * Pre-stream errors (status >= 500 returned as buffered) DO retry.
 */
export async function forwardWithFallback(
  ctx: RequestContext,
  keys: ResolvedProviderKey[],
  timeoutMs: number,
  streamingRequested: boolean,
): Promise<FallbackForwardResult> {
  const originalProvider = detectProvider(ctx.targetUrl) as Format | null;
  let lastResult: FallbackForwardResult | null = null;

  // Snapshot the original ctx fields we mutate per attempt so we can restore
  // them between fallback attempts.
  const originalBody = ctx.body;
  const originalParsedBody = ctx.parsedBody;
  const originalTargetUrl = ctx.targetUrl;

  for (const key of keys) {
    const isCrossProvider =
      originalProvider !== null && key.provider !== originalProvider;
    let needsResponseTranslation = false;

    if (isCrossProvider) {
      // Cross-provider fallback requires translation. The fallback key MUST have
      // a default_model since the original request body specified a model from
      // the original provider, which is meaningless for the fallback provider.
      if (!key.default_model) {
        console.debug(
          `[fallback] skipping cross-provider key ${key.id} — no default_model set`,
        );
        continue;
      }

      const targetProvider = key.provider as Format;
      try {
        const translatedBody = translateRequest(
          originalProvider,
          targetProvider,
          originalParsedBody,
          key.default_model,
        );
        ctx.body = JSON.stringify(translatedBody);
        ctx.parsedBody = translatedBody;
        ctx.targetUrl = providerUrl(targetProvider);
        needsResponseTranslation = true;
      } catch (err) {
        if (err instanceof TranslationNotSupportedError) {
          console.debug(`[fallback] skipping key ${key.id}: ${err.message}`);
          // Restore ctx for the next iteration in case we partially mutated
          ctx.body = originalBody;
          ctx.parsedBody = originalParsedBody;
          ctx.targetUrl = originalTargetUrl;
          continue;
        }
        throw err;
      }
    }

    // Mutate the auth-forward header for this attempt. Invariant: always
    // `Bearer <key>` — forward.ts strips the prefix for Anthropic's x-api-key.
    ctx.headers["x-grepture-auth-forward"] = `Bearer ${key.decrypted}`;

    const result = await forwardRequest(ctx, timeoutMs, streamingRequested);

    // Restore ctx fields for the next iteration (in case we need to fall back further)
    if (isCrossProvider) {
      ctx.body = originalBody;
      ctx.parsedBody = originalParsedBody;
      ctx.targetUrl = originalTargetUrl;
    }

    // Streaming responses cannot be retried — once we have a stream we're committed
    if (result.mode === "streaming") {
      if (needsResponseTranslation && originalProvider) {
        const translator = createStreamingTranslator(key.provider as Format, originalProvider);
        return {
          ...result,
          rawBody: result.rawBody.pipeThrough(translator),
          keyIdUsed: key.id,
        };
      }
      return { ...result, keyIdUsed: key.id };
    }

    // Buffered: if the status is retriable, try next key; otherwise return.
    if (shouldFallback(result.status)) {
      lastResult = { ...result, keyIdUsed: key.id };
      continue;
    }

    // Translate the buffered response body back to the caller's expected format.
    // Only translate successful responses — error bodies are provider-specific
    // JSON that would produce garbage if fed through the message translator.
    if (needsResponseTranslation && originalProvider && result.status >= 200 && result.status < 300) {
      try {
        const parsed = JSON.parse(result.body);
        const translated = translateResponse(key.provider as Format, originalProvider, parsed);
        result.body = JSON.stringify(translated);
      } catch (err) {
        console.error(`[fallback] response translation failed for key ${key.id}:`, err);
        // Translation failed — fall through and return the untranslated body
      }
    }

    return { ...result, keyIdUsed: key.id };
  }

  // All keys failed (or chain was empty after filtering) — return the last 5xx,
  // or a synthetic 502 if nothing was attempted at all.
  if (lastResult) return lastResult;
  return {
    mode: "buffered",
    status: 502,
    headers: {},
    body: JSON.stringify({ error: "No usable provider key in fallback chain" }),
    keyIdUsed: null,
  };
}
