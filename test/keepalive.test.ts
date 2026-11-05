import { describe, it, expect } from "bun:test";
import { EARLY_STREAM_HEADER, deferredStreamingResult, parseKeepaliveHeader, settleWithin, sseErrorEvent, sseErrorFormat, withHeartbeat } from "../src/proxy/keepalive";
import { forwardRequest } from "../src/proxy/forward";
import type { RequestContext } from "../src/types";
import { createResponsesToChatStream } from "../src/proxy/responses-to-chat-stream";
import type { ForwardResult } from "../src/proxy/forward";

const encoder = new TextEncoder();

/** Emits each [delayMs, text] step in order, then closes. */
function scriptedStream(steps: Array<[number, string]>): ReadableStream<Uint8Array> {
  return new ReadableStream({
    async start(controller) {
      for (const [delay, text] of steps) {
        await Bun.sleep(delay);
        controller.enqueue(encoder.encode(text));
      }
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

describe("settleWithin", () => {
  it("returns the value when the promise settles in time", async () => {
    expect(await settleWithin(Promise.resolve("ok"), 50)).toBe("ok");
  });

  it("returns null when the promise is still pending", async () => {
    expect(await settleWithin(Bun.sleep(200).then(() => "late"), 20)).toBeNull();
  });
});

describe("withHeartbeat", () => {
  it("sends keep-alives while the source is silent", async () => {
    const out = await collect(withHeartbeat(scriptedStream([[150, "data: 1\n\n"]]), 40));
    expect(out.match(/: keepalive\n\n/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(out.endsWith("data: 1\n\n")).toBe(true);
  });

  it("never injects inside a partially sent event", async () => {
    const out = await collect(withHeartbeat(scriptedStream([[0, "data: {\"a\":"], [150, "1}\n\n"]]), 40));
    expect(out).toBe("data: {\"a\":1}\n\n");
  });

  it("sends one keep-alive immediately when asked", async () => {
    const out = await collect(withHeartbeat(scriptedStream([[0, "data: 1\n\n"]]), 1000, true));
    expect(out).toBe(": keepalive\n\ndata: 1\n\n");
  });

  it("passes fast streams through unchanged", async () => {
    const out = await collect(withHeartbeat(scriptedStream([[0, "data: 1\n\n"], [0, "data: [DONE]\n\n"]]), 1000));
    expect(out).toBe("data: 1\n\ndata: [DONE]\n\n");
  });
});

describe("parseKeepaliveHeader", () => {
  it("defaults to on", () => {
    expect(parseKeepaliveHeader(undefined)).toEqual({ enabled: true });
    expect(parseKeepaliveHeader("ON")).toEqual({ enabled: true });
  });

  it("accepts off", () => {
    expect(parseKeepaliveHeader(" off ")).toEqual({ enabled: false });
  });

  it("rejects anything else", () => {
    expect("error" in parseKeepaliveHeader("no")).toBe(true);
  });
});

describe("sseErrorFormat", () => {
  it("uses the Anthropic shape for api.anthropic.com", () => {
    expect(sseErrorFormat("https://api.anthropic.com/v1/messages")).toBe("anthropic");
  });

  it("uses the Anthropic shape for /v1/messages on any host", () => {
    expect(sseErrorFormat("https://llm.example.com/proxy/v1/messages?beta=true")).toBe("anthropic");
  });

  it("uses the OpenAI shape otherwise", () => {
    expect(sseErrorFormat("https://llm.example.com/v1/chat/completions")).toBe("openai");
    expect(sseErrorFormat("not a url")).toBe("openai");
  });
});

function eventData(event: string): Record<string, unknown> {
  const line = event.split("\n").find((l) => l.startsWith("data: "));
  return JSON.parse(line!.slice(6));
}

describe("sseErrorEvent", () => {
  it("passes an Anthropic error body through, adding the upstream status", () => {
    const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" }, request_id: "req_1" });
    const event = sseErrorEvent("anthropic", 529, body);
    expect(event.startsWith("event: error\ndata: ")).toBe(true);
    expect(eventData(event)).toEqual({ type: "error", error: { type: "overloaded_error", message: "Overloaded", status: 529 }, request_id: "req_1" });
  });

  it("carries retry-after", () => {
    const body = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Slow down" } });
    expect(eventData(sseErrorEvent("anthropic", 429, body, "12")).error).toEqual({ type: "rate_limit_error", message: "Slow down", status: 429, retry_after: "12" });
    expect(eventData(sseErrorEvent("openai", 429, JSON.stringify({ error: { message: "Slow down" } }), "12")).error).toEqual({ message: "Slow down", status: 429, retry_after: "12" });
  });

  it("maps an OpenAI-shaped error to an Anthropic event with a typed error", () => {
    const event = sseErrorEvent("anthropic", 429, JSON.stringify({ error: { message: "Rate limited" } }));
    expect(eventData(event).error).toEqual({ type: "rate_limit_error", message: "Rate limited", status: 429 });
  });

  it("wraps the proxy's own errors in the Anthropic shape", () => {
    const event = sseErrorEvent("anthropic", 504, JSON.stringify({ error: "Gateway timeout" }));
    expect(eventData(event).error).toEqual({ type: "timeout_error", message: "Gateway timeout", status: 504 });
  });

  it("wraps a non-JSON Anthropic error", () => {
    expect(eventData(sseErrorEvent("anthropic", 502, "")).error).toEqual({ type: "api_error", message: "Upstream returned status 502", status: 502 });
  });

  it("emits OpenAI-style errors as a data event with an error field", () => {
    const body = JSON.stringify({ error: { message: "Rate limited", type: "rate_limit" } });
    expect(sseErrorEvent("openai", 429, body)).toBe(`data: ${JSON.stringify({ error: { message: "Rate limited", type: "rate_limit", status: 429 } })}\n\n`);
  });

  it("wraps the proxy's own gateway timeout", () => {
    const event = sseErrorEvent("openai", 504, JSON.stringify({ error: "Gateway timeout" }));
    expect(eventData(event)).toEqual({ error: { message: "Gateway timeout", code: 504, status: 504 } });
  });

  it("keeps the detail of the proxy's own errors", () => {
    const event = sseErrorEvent("openai", 502, JSON.stringify({ error: "Failed to reach target", detail: "socket closed" }));
    expect(eventData(event)).toEqual({ error: { message: "Failed to reach target: socket closed", code: 502, status: 502 } });
  });
});

const upstreamComment = (status: number, headers: Record<string, string>) =>
  `: grepture-upstream ${JSON.stringify({ status, headers })}\n\n`;

describe("deferredStreamingResult", () => {
  it("marks the stream as committed early", () => {
    const result = deferredStreamingResult(new Promise(() => {}), "openai");
    expect(result.headers[EARLY_STREAM_HEADER]).toBe("true");
  });

  it("sends the upstream headers as a comment, then relays the stream", async () => {
    const headers = { "content-type": "text/event-stream", "x-upstream": "1" };
    const upstream: ForwardResult = { mode: "streaming", status: 200, headers, rawBody: scriptedStream([[0, "data: hi\n\n"]]) };
    const result = deferredStreamingResult(Bun.sleep(30).then(() => upstream), "openai");
    if (result.mode !== "streaming") throw new Error("expected streaming");
    expect(await collect(result.rawBody)).toBe(upstreamComment(200, headers) + "data: hi\n\n");
    expect(result.headers["x-upstream"]).toBe("1");
  });

  it("turns a late upstream error into an SSE error event with status and retry-after", async () => {
    const headers = { "retry-after": "7" };
    const upstream: ForwardResult = { mode: "buffered", status: 429, headers, body: JSON.stringify({ error: { message: "boom" } }) };
    const result = deferredStreamingResult(Bun.sleep(30).then(() => upstream), "openai");
    if (result.mode !== "streaming") throw new Error("expected streaming");
    expect(await collect(result.rawBody)).toBe(upstreamComment(429, headers) + `data: ${JSON.stringify({ error: { message: "boom", status: 429, retry_after: "7" } })}\n\n`);
    expect(result.status).toBe(429);
  });

  it("sends event: error for a late error on an Anthropic-format request", async () => {
    const upstream: ForwardResult = { mode: "buffered", status: 529, headers: {}, body: JSON.stringify({ error: { message: "busy" } }) };
    const result = deferredStreamingResult(Bun.sleep(10).then(() => upstream), sseErrorFormat("https://llm.example.com/v1/messages"));
    if (result.mode !== "streaming") throw new Error("expected streaming");
    expect(await collect(result.rawBody)).toContain("event: error\ndata: ");
  });

  it("calls onCancel when the caller disconnects before the upstream answers", async () => {
    let cancelled = false;
    const result = deferredStreamingResult(new Promise(() => {}), "openai", () => { cancelled = true; });
    if (result.mode !== "streaming") throw new Error("expected streaming");
    await result.rawBody.cancel();
    expect(cancelled).toBe(true);
  });
});

describe("forwardRequest with a client signal", () => {
  it("aborts the upstream request as soon as the client disconnects", async () => {
    let upstreamAborted = false;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        req.signal.addEventListener("abort", () => { upstreamAborted = true; });
        await Bun.sleep(2000);
        return new Response("late");
      },
    });
    try {
      const client = new AbortController();
      const ctx = { method: "POST", headers: {}, body: "{}", targetUrl: `http://localhost:${server.port}/v1/chat/completions` } as RequestContext;
      const pending = forwardRequest(ctx, 10_000, true, client.signal);
      await Bun.sleep(100);
      client.abort();
      const result = await pending;
      await Bun.sleep(100);
      expect(result.status).toBe(499);
      expect(upstreamAborted).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});

describe("createResponsesToChatStream errors", () => {
  it("forwards error events instead of dropping them", async () => {
    const out = await collect(createResponsesToChatStream(scriptedStream([[0, `data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`]])));
    expect(out).toContain(`data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`);
  });

  it("maps a native Responses API error event", async () => {
    const out = await collect(createResponsesToChatStream(scriptedStream([[0, `event: error\ndata: ${JSON.stringify({ type: "error", code: "server_error", message: "boom" })}\n\n`]])));
    expect(out).toContain(`data: ${JSON.stringify({ error: { message: "boom", code: "server_error" } })}\n\n`);
  });
});
