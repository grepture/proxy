import { describe, it, expect } from "bun:test";
import { deferredStreamingResult, settleWithin, sseErrorEvent, withHeartbeat } from "../src/proxy/keepalive";
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

describe("sseErrorEvent", () => {
  it("passes an Anthropic error body through as an error event", () => {
    const body = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    expect(sseErrorEvent("anthropic", 529, body)).toBe(`event: error\ndata: ${body}\n\n`);
  });

  it("wraps a non-JSON Anthropic error", () => {
    const event = sseErrorEvent("anthropic", 504, "");
    expect(event.startsWith("event: error\ndata: ")).toBe(true);
    expect(JSON.parse(event.split("data: ")[1]).error.type).toBe("api_error");
  });

  it("emits OpenAI-style errors as a data event with an error field", () => {
    const body = JSON.stringify({ error: { message: "Rate limited", type: "rate_limit" } });
    expect(sseErrorEvent(null, 429, body)).toBe(`data: ${JSON.stringify({ error: { message: "Rate limited", type: "rate_limit" } })}\n\n`);
  });

  it("wraps the proxy's own gateway timeout", () => {
    const event = sseErrorEvent("openai", 504, JSON.stringify({ error: "Gateway timeout" }));
    expect(JSON.parse(event.slice(6))).toEqual({ error: "Gateway timeout" });
  });
});

describe("deferredStreamingResult", () => {
  it("relays the upstream stream and records its real status and headers", async () => {
    const upstream: ForwardResult = {
      mode: "streaming",
      status: 200,
      headers: { "content-type": "text/event-stream", "x-upstream": "1" },
      rawBody: scriptedStream([[0, "data: hi\n\n"]]),
    };
    const result = deferredStreamingResult(Bun.sleep(30).then(() => upstream), "openai");
    if (result.mode !== "streaming") throw new Error("expected streaming");
    expect(await collect(result.rawBody)).toBe("data: hi\n\n");
    expect(result.headers["x-upstream"]).toBe("1");
  });

  it("turns a late upstream error into an SSE error event", async () => {
    const upstream: ForwardResult = { mode: "buffered", status: 500, headers: {}, body: JSON.stringify({ error: { message: "boom" } }) };
    const result = deferredStreamingResult(Bun.sleep(30).then(() => upstream), null);
    if (result.mode !== "streaming") throw new Error("expected streaming");
    expect(await collect(result.rawBody)).toBe(`data: ${JSON.stringify({ error: { message: "boom" } })}\n\n`);
    expect(result.status).toBe(500);
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
