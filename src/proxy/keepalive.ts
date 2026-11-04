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
  return typeof value === "object" && value !== null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Formats an upstream error as an SSE event in the shape the provider's SDKs
 * already raise on: Anthropic `event: error`, OpenAI-style `data: {"error":…}`.
 */
export function sseErrorEvent(provider: "openai" | "anthropic" | "gemini" | null, status: number, body: string): string {
  const parsed = tryParse(body);
  const message = body || `Upstream returned status ${status}`;

  if (provider === "anthropic") {
    const payload = isRecord(parsed) && parsed.type === "error"
      ? parsed
      : { type: "error", error: { type: "api_error", message } };
    return `event: error\ndata: ${JSON.stringify(payload)}\n\n`;
  }

  const error = isRecord(parsed) && parsed.error !== undefined ? parsed.error : { message, code: status };
  return `data: ${JSON.stringify({ error })}\n\n`;
}

/**
 * A streaming result standing in for an upstream that hasn't answered yet.
 * Its body waits for `pending`, then relays the upstream stream, or an SSE
 * error event if the upstream failed. status and headers are updated in place
 * once the upstream answers, so end-of-stream logging records the real values.
 */
export function deferredStreamingResult(
  pending: Promise<ForwardResult>,
  provider: "openai" | "anthropic" | "gemini" | null,
): ForwardResult {
  const encoder = new TextEncoder();
  let cancelUpstream: ((reason: unknown) => Promise<void>) | null = null;
  let cancelled = false;

  const result: ForwardResult = {
    mode: "streaming",
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
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

          if (upstream.mode === "buffered") {
            const ok = upstream.status >= 200 && upstream.status < 300;
            controller.enqueue(encoder.encode(ok ? upstream.body : sseErrorEvent(provider, upstream.status, upstream.body)));
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
        return cancelUpstream?.(reason);
      },
    }),
  };
  return result;
}
