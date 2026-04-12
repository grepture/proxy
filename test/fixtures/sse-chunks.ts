/**
 * SSE event strings and helpers for streaming tests.
 */

/** Build an OpenAI-style SSE text delta event */
export function openaiDelta(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-test",
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}`;
}

/** Build an Anthropic-style SSE text delta event */
export function anthropicDelta(text: string): string {
  return `data: ${JSON.stringify({
    type: "content_block_delta",
    delta: { type: "text_delta", text },
  })}`;
}

/** SSE done marker (OpenAI) */
export const OPENAI_DONE = "data: [DONE]";

/** Anthropic message_stop event */
export const ANTHROPIC_STOP = `data: ${JSON.stringify({ type: "message_stop" })}`;

/** Anthropic message_start (non-text event) */
export const ANTHROPIC_START = `data: ${JSON.stringify({
  type: "message_start",
  message: { id: "msg-test", type: "message", role: "assistant" },
})}`;

/** Anthropic content_block_start (non-text event) */
export const ANTHROPIC_BLOCK_START = `data: ${JSON.stringify({
  type: "content_block_start",
  index: 0,
  content_block: { type: "text", text: "" },
})}`;

/** Anthropic ping event */
export const ANTHROPIC_PING = `event: ping\ndata: {}`;

/**
 * Encode SSE events into a Uint8Array chunk.
 * Each event is separated by \n\n as per SSE spec.
 */
export function encodeSSE(...events: string[]): Uint8Array {
  return new TextEncoder().encode(events.map((e) => e + "\n\n").join(""));
}

/**
 * Create a ReadableStream from an array of Uint8Array chunks.
 * Each chunk is enqueued separately to simulate real streaming.
 */
export function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}
