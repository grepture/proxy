import type { ForwardResult } from "./forward";

/**
 * Keep-alives for streaming requests.
 *
 * The hosted proxy sits behind a load balancer that drops connections silent
 * for longer than its idle timeout (max 300s on Hetzner). Large prompts can
 * take longer than that before the first byte. For streaming requests we
 * commit a 200 SSE response once the upstream has been silent for
 * KEEPALIVE_GRACE_MS, then send SSE comments, which spec-compliant SSE clients
 * ignore but which reset idle timers on every hop. Requests answered within
 * the grace period are unaffected and keep the upstream's real status.
 */
export const KEEPALIVE_GRACE_MS = 20_000;
export const KEEPALIVE_INTERVAL_MS = 15_000;

const HEARTBEAT = new TextEncoder().encode(": keepalive\n\n");
const LF = 10;
const CR = 13;

/**
 * Parses X-Grepture-Keepalive. "off" makes a streaming request wait for the
 * upstream's real response (status and headers) instead of being committed
 * early; behind a load balancer the wait is then bounded by its idle timeout.
 */
export function parseKeepaliveHeader(value: string | undefined): { enabled: boolean } | { error: string } {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "on") return { enabled: true };
  if (normalized === "off") return { enabled: false };
  return { error: "Invalid X-Grepture-Keepalive: expected \"on\" or \"off\"" };
}

/** Resolves with the promise's value, or null if it hasn't settled within ms. */
export async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Passes `source` through, sending an SSE comment whenever it has been silent
 * for intervalMs. Comments only go out between events: injecting one inside a
 * partially sent event would end that event early. With sendNow, one goes out
 * immediately: Bun holds back response headers until the first body byte.
 */
export function withHeartbeat(source: ReadableStream<Uint8Array>, intervalMs: number, sendNow = false): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastWrite = Date.now();
  // Last two bytes written, to detect an event boundary ("\n\n" or "\r\n\r\n").
  let prev1 = LF;
  let prev2 = LF;
  let finished = false;

  const finish = () => {
    finished = true;
    clearInterval(timer);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (sendNow) controller.enqueue(HEARTBEAT);
      timer = setInterval(() => {
        const atBoundary = prev1 === LF && (prev2 === LF || prev2 === CR);
        if (finished || !atBoundary || Date.now() - lastWrite < intervalMs) return;
        controller.enqueue(HEARTBEAT);
        lastWrite = Date.now();
      }, Math.max(10, Math.floor(intervalMs / 4)));

      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (finished) return;
            controller.enqueue(value);
            lastWrite = Date.now();
            if (value.length >= 2) {
              prev2 = value[value.length - 2];
              prev1 = value[value.length - 1];
            } else if (value.length === 1) {
              prev2 = prev1;
              prev1 = value[0];
            }
          }
          if (!finished) {
            finish();
            controller.close();
          }
        } catch (err) {
          if (!finished) {
            finish();
            controller.error(err);
          }
        }
      })();
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export type SseErrorFormat = "anthropic" | "openai";

/**
 * Which SSE error shape the caller's SDK raises on. Anthropic's Messages API
 * is recognised by path too, so Anthropic-compatible hosts get `event: error`.
 */
export function sseErrorFormat(targetUrl: string): SseErrorFormat {
  try {
    const url = new URL(targetUrl);
    if (url.hostname.includes("anthropic.com") || url.pathname.endsWith("/v1/messages")) return "anthropic";
  } catch {
    // Invalid URL: fall through to the OpenAI shape.
  }
  return "openai";
}

const ANTHROPIC_ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  413: "request_too_large",
  429: "rate_limit_error",
  504: "timeout_error",
  529: "overloaded_error",
};

// Readable text for an error body: the proxy's own `{ error: "…", detail? }`,
// an OpenAI-style `{ error: { message } }`, or the raw body.
function errorMessage(parsed: unknown, body: string, status: number): string {
  if (isRecord(parsed)) {
    if (typeof parsed.error === "string") {
      return typeof parsed.detail === "string" ? `${parsed.error}: ${parsed.detail}` : parsed.error;
    }
    if (isRecord(parsed.error) && typeof parsed.error.message === "string") return parsed.error.message;
  }
  return body || `Upstream returned status ${status}`;
}

/**
 * Formats an error that arrived after the response was committed as an SSE
 * event in the shape the provider's SDKs raise on: Anthropic `event: error`,
 * OpenAI-style `data: {"error":…}`. The error object also carries the
 * upstream's HTTP `status` and, when sent, its `retry_after` header value.
 */
export function sseErrorEvent(format: SseErrorFormat, status: number, body: string, retryAfter?: string): string {
  const parsed = tryParse(body);
  const extra: Record<string, unknown> = { status };
  if (retryAfter) extra.retry_after = retryAfter;

  if (format === "anthropic") {
    // An Anthropic error body (with its request_id) passes through as is.
    const isAnthropicBody = isRecord(parsed) && parsed.type === "error" && isRecord(parsed.error);
    const error = isAnthropicBody && isRecord(parsed.error) ? parsed.error : {
      type: ANTHROPIC_ERROR_TYPES[status] ?? "api_error",
      message: errorMessage(parsed, body, status),
    };
    const payload = { ...(isAnthropicBody ? parsed : {}), type: "error", error: { ...error, ...extra } };
    return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  // The proxy's own errors are `{ error: "…" }`; SDKs read `error.message`,
  // so anything but an error object is wrapped to keep its text visible.
  const error = isRecord(parsed) && isRecord(parsed.error)
    ? parsed.error
    : { message: errorMessage(parsed, body, status), code: status };
  return `data: ${JSON.stringify({ error: { ...error, ...extra } })}\n\n`;
}

/**
 * SSE comment carrying the upstream's real status and headers, sent first on
 * a stream committed before the upstream answered (the HTTP headers had
 * already gone out). SDKs ignore comments; custom clients can read it.
 */
function upstreamHeadersComment(status: number, headers: Record<string, string>): string {
  return `: grepture-upstream ${JSON.stringify({ status, headers })}\n\n`;
}

/** Response header marking a stream the proxy committed before the upstream answered. */
export const EARLY_STREAM_HEADER = "x-grepture-early-stream";

/**
 * A streaming result standing in for an upstream that hasn't answered yet.
 * Its body waits for `pending`, sends the upstream's status and headers as an
 * SSE comment, then relays the upstream stream, or an SSE error event if the
 * upstream failed. status and headers are updated in place once the upstream
 * answers, so end-of-stream logging records the real values. If the caller
 * disconnects while still waiting, onCancel aborts the upstream request.
 */
export function deferredStreamingResult(
  pending: Promise<ForwardResult>,
  format: SseErrorFormat,
  onCancel?: () => void,
): ForwardResult {
  const encoder = new TextEncoder();
  let cancelUpstream: ((reason: unknown) => Promise<void>) | null = null;
  let cancelled = false;

  const result: ForwardResult = {
    mode: "streaming",
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8", [EARLY_STREAM_HEADER]: "true" },
    rawBody: new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          const upstream = await pending;
          result.status = upstream.status;
          result.headers = upstream.headers;
          if (cancelled) {
            if (upstream.mode === "streaming") await upstream.rawBody.cancel();
            return;
          }

          controller.enqueue(encoder.encode(upstreamHeadersComment(upstream.status, upstream.headers)));

          if (upstream.mode === "buffered") {
            const ok = upstream.status >= 200 && upstream.status < 300;
            controller.enqueue(encoder.encode(ok
              ? upstream.body
              : sseErrorEvent(format, upstream.status, upstream.body, upstream.headers["retry-after"])));
            controller.close();
            return;
          }

          const reader = upstream.rawBody.getReader();
          cancelUpstream = (reason) => reader.cancel(reason);
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
          if (!cancelled) controller.error(err);
        }
      },
      cancel(reason) {
        cancelled = true;
        if (cancelUpstream) return cancelUpstream(reason);
        onCancel?.();
      },
    }),
  };
  return result;
}
