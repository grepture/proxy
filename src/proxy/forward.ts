import type { RequestContext } from "../types";

export type ForwardResult =
  | { mode: "buffered"; status: number; headers: Record<string, string>; body: string }
  | { mode: "streaming"; status: number; headers: Record<string, string>; rawBody: ReadableStream<Uint8Array> };

export async function forwardRequest(
  ctx: RequestContext,
  timeoutMs: number,
  streamingRequested = false,
): Promise<ForwardResult> {
  // Build outbound headers
  const outboundHeaders: Record<string, string> = {};

  for (const [key, value] of Object.entries(ctx.headers)) {
    const lower = key.toLowerCase();
    // Strip Grepture auth, internal headers, and browser-context headers
    // (the proxy is a server — upstream providers shouldn't see browser origin)
    if (lower === "authorization") continue;
    if (lower.startsWith("x-grepture-")) continue;
    if (lower === "host") continue;
    if (lower === "content-length") continue; // recalculated by fetch from actual body
    if (lower === "origin" || lower === "referer") continue;
    if (lower.startsWith("sec-")) continue;
    outboundHeaders[key] = value;
  }

  // Map X-Grepture-Auth-Forward → appropriate auth header on outbound
  const authForward = ctx.headers["x-grepture-auth-forward"];
  if (authForward) {
    const host = new URL(ctx.targetUrl).hostname;
    if (host.includes("anthropic.com")) {
      // Anthropic uses x-api-key header; strip Bearer prefix if present
      outboundHeaders["x-api-key"] = authForward.replace(/^Bearer\s+/i, "");
      // Anthropic requires this header on every request
      if (!outboundHeaders["anthropic-version"]) {
        outboundHeaders["anthropic-version"] = "2023-06-01";
      }
    } else {
      outboundHeaders["authorization"] = authForward;
    }
  }

  // Add X-Forwarded-For
  outboundHeaders["x-forwarded-for"] =
    ctx.headers["x-forwarded-for"] || ctx.headers["cf-connecting-ip"] || "unknown";

  // Timeout via AbortController
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const hasBody = ctx.method !== "GET" && ctx.method !== "HEAD";

    const response = await fetch(ctx.targetUrl, {
      method: ctx.method,
      headers: outboundHeaders,
      body: hasBody ? ctx.body : undefined,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    // Extract response headers
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    // Streaming mode: only when the upstream actually returned a successful
    // streamable response. Error responses (4xx/5xx) always go through the
    // buffered path even if the caller asked for streaming, so that
    // forwardWithFallback can retry them on the next key in the chain.
    const contentType = response.headers.get("content-type") || "";
    const isSse = contentType.includes("text/event-stream");
    const isSuccessfulStreamRequest =
      streamingRequested && response.status >= 200 && response.status < 300;
    if ((isSse || isSuccessfulStreamRequest) && response.body) {
      return {
        mode: "streaming",
        status: response.status,
        headers: responseHeaders,
        rawBody: response.body,
      };
    }

    // Buffered mode (default, or fallback when upstream returns non-SSE)
    const responseBody = await response.text();

    return {
      mode: "buffered",
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { mode: "buffered", status: 504, headers: {}, body: JSON.stringify({ error: "Gateway timeout" }) };
    }
    return {
      mode: "buffered",
      status: 502,
      headers: {},
      body: JSON.stringify({ error: "Failed to reach target", detail: String(err) }),
    };
  }
}
