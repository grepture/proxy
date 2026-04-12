import type { Format } from "./types";
import { TranslationNotSupportedError } from "./types";

/**
 * Returns a TransformStream that translates SSE events from one provider format
 * to another. Used by forward-with-fallback when a cross-provider fallback fires
 * and the request was streaming.
 *
 * Identity transform when source === target.
 */
export function createStreamingTranslator(
  source: Format,
  target: Format,
): TransformStream<Uint8Array, Uint8Array> {
  if (source === target) {
    return new TransformStream<Uint8Array, Uint8Array>();
  }
  if (source === "anthropic" && target === "openai") {
    return anthropicToOpenaiStream();
  }
  if (source === "openai" && target === "anthropic") {
    return openaiToAnthropicStream();
  }
  throw new TranslationNotSupportedError(`unsupported streaming translation: ${source} → ${target}`);
}

// ─── SSE event parsing ──────────────────────────────────────────────────────

type SseEvent = {
  /** Event type from `event:` line, or null if absent (OpenAI doesn't use these). */
  event: string | null;
  /** Concatenated data lines from `data:` line(s). */
  data: string;
};

/**
 * Stateful SSE parser. Feed it text chunks via `feed()`, get back any complete
 * events that have been parsed. Partial events are buffered until the next call.
 */
class SseParser {
  private buffer = "";

  feed(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    let idx: number;
    // SSE events are separated by blank lines (\n\n). Use a loop to find each.
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      const ev = parseEventBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush(): SseEvent[] {
    // Anything left in the buffer at end-of-stream
    if (this.buffer.trim().length === 0) return [];
    const ev = parseEventBlock(this.buffer);
    this.buffer = "";
    return ev ? [ev] : [];
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith(":")) continue; // ignore comments
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (dataLines.length === 0 && !event) return null;
  return { event, data: dataLines.join("\n") };
}

function encodeChunk(data: string, eventType: string | null = null): Uint8Array {
  let s = "";
  if (eventType) s += `event: ${eventType}\n`;
  s += `data: ${data}\n\n`;
  return new TextEncoder().encode(s);
}

// ─── Anthropic → OpenAI streaming ───────────────────────────────────────────

function anthropicToOpenaiStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const parser = new SseParser();

  // Per-stream state
  let chatcmplId = "";
  let model = "";
  let roleEmitted = false;
  let finishReason: string | null = null;
  let toolCallIndex = 0; // running index for OpenAI tool_calls deltas
  let inputTokens = 0;
  let outputTokens = 0;

  function makeId(srcId: string): string {
    return srcId.startsWith("msg_") ? `chatcmpl-${srcId.slice(4)}` : `chatcmpl-${srcId}`;
  }

  function mapStop(reason: string | null | undefined): string {
    switch (reason) {
      case "end_turn": return "stop";
      case "max_tokens": return "length";
      case "stop_sequence": return "stop";
      case "tool_use": return "tool_calls";
      default: return "stop";
    }
  }

  function emitChunk(controller: TransformStreamDefaultController<Uint8Array>, delta: Record<string, unknown>, finish: string | null = null): void {
    const chunk = {
      id: chatcmplId || "chatcmpl-unknown",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: model || null,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finish,
        },
      ],
    };
    controller.enqueue(encodeChunk(JSON.stringify(chunk)));
  }

  function ensureRoleEmitted(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (roleEmitted) return;
    emitChunk(controller, { role: "assistant", content: "" });
    roleEmitted = true;
  }

  function processEvents(events: SseEvent[], controller: TransformStreamDefaultController<Uint8Array>): void {
    for (const ev of events) {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        continue; // skip malformed
      }

      const type = (payload.type as string) || ev.event;

      if (type === "message_start") {
        const msg = (payload.message as Record<string, unknown> | undefined) ?? {};
        const srcId = typeof msg.id === "string" ? msg.id : "msg_unknown";
        chatcmplId = makeId(srcId);
        if (typeof msg.model === "string") model = msg.model;
        const usage = msg.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.input_tokens === "number") {
          inputTokens = usage.input_tokens;
        }
        ensureRoleEmitted(controller);
      } else if (type === "content_block_start") {
        const block = (payload.content_block as Record<string, unknown> | undefined) ?? {};
        if (block.type === "tool_use") {
          ensureRoleEmitted(controller);
          emitChunk(controller, {
            tool_calls: [{
              index: toolCallIndex,
              id: block.id,
              type: "function",
              function: { name: block.name, arguments: "" },
            }],
          });
          toolCallIndex++;
        }
      } else if (type === "content_block_delta") {
        const delta = (payload.delta as Record<string, unknown> | undefined) ?? {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          ensureRoleEmitted(controller);
          emitChunk(controller, { content: delta.text });
        } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string" && delta.partial_json.length > 0) {
          emitChunk(controller, {
            tool_calls: [{
              index: toolCallIndex - 1,
              function: { arguments: delta.partial_json },
            }],
          });
        }
      } else if (type === "message_delta") {
        const delta = (payload.delta as Record<string, unknown> | undefined) ?? {};
        if (typeof delta.stop_reason === "string") {
          finishReason = mapStop(delta.stop_reason);
        }
        const usage = payload.usage as Record<string, unknown> | undefined;
        if (usage && typeof usage.output_tokens === "number") {
          outputTokens = usage.output_tokens;
        }
      } else if (type === "message_stop") {
        emitChunk(controller, {}, finishReason ?? "stop");
        // Emit an OpenAI-style usage chunk so extractUsage can find token counts
        const usageChunk = {
          id: chatcmplId || "chatcmpl-unknown",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: model || null,
          choices: [] as unknown[],
          usage: {
            prompt_tokens: inputTokens,
            completion_tokens: outputTokens,
            total_tokens: inputTokens + outputTokens,
          },
        };
        controller.enqueue(encodeChunk(JSON.stringify(usageChunk)));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
      }
      // Ignore: content_block_stop, ping, error, and unknown
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      processEvents(parser.feed(text), controller);
    },
    flush(controller) {
      processEvents(parser.flush(), controller);
    },
  });
}

// ─── OpenAI → Anthropic streaming ───────────────────────────────────────────

function openaiToAnthropicStream(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const parser = new SseParser();

  let messageStarted = false;
  let stopped = false;
  let msgId = "";
  let model = "";

  // Content block tracking
  let contentBlockIndex = 0;
  let textBlockStarted = false;
  let textBlockStopped = false;
  // OpenAI tool call index → { blockIndex } for Anthropic content blocks
  const activeToolCalls = new Map<number, { blockIndex: number }>();

  function makeId(srcId: string): string {
    return srcId.startsWith("chatcmpl-") ? `msg_${srcId.slice(9)}` : `msg_${srcId}`;
  }

  function mapFinish(reason: string | null | undefined): string {
    switch (reason) {
      case "stop": return "end_turn";
      case "length": return "max_tokens";
      case "tool_calls": return "tool_use";
      case "content_filter": return "end_turn";
      default: return "end_turn";
    }
  }

  function emitMessageStart(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (messageStarted) return;
    messageStarted = true;
    controller.enqueue(encodeChunk(JSON.stringify({
      type: "message_start",
      message: {
        id: msgId || "msg_unknown",
        type: "message",
        role: "assistant",
        content: [],
        model: model || null,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    }), "message_start"));
  }

  function emitTextBlockStart(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (textBlockStarted) return;
    textBlockStarted = true;
    emitMessageStart(controller);
    const idx = contentBlockIndex++;
    controller.enqueue(encodeChunk(JSON.stringify({
      type: "content_block_start",
      index: idx,
      content_block: { type: "text", text: "" },
    }), "content_block_start"));
  }

  function emitTextBlockStop(controller: TransformStreamDefaultController<Uint8Array>): void {
    if (!textBlockStarted || textBlockStopped) return;
    textBlockStopped = true;
    // Text block is always at index 0
    controller.enqueue(
      encodeChunk(JSON.stringify({ type: "content_block_stop", index: 0 }), "content_block_stop"),
    );
  }

  function stop(controller: TransformStreamDefaultController<Uint8Array>, finishReason: string): void {
    if (stopped) return;
    stopped = true;
    // Close text block if open
    emitTextBlockStop(controller);
    // Close all open tool call blocks
    for (const [, tc] of activeToolCalls) {
      controller.enqueue(
        encodeChunk(JSON.stringify({ type: "content_block_stop", index: tc.blockIndex }), "content_block_stop"),
      );
    }
    // message_delta with stop_reason
    controller.enqueue(encodeChunk(JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: mapFinish(finishReason), stop_sequence: null },
      usage: { output_tokens: 0 },
    }), "message_delta"));
    // message_stop
    controller.enqueue(encodeChunk(JSON.stringify({ type: "message_stop" }), "message_stop"));
  }

  function processEvents(events: SseEvent[], controller: TransformStreamDefaultController<Uint8Array>): void {
    for (const ev of events) {
      if (ev.data === "[DONE]") {
        if (messageStarted && !stopped) stop(controller, "stop");
        continue;
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        continue;
      }

      if (!msgId && typeof payload.id === "string") msgId = makeId(payload.id);
      if (!model && typeof payload.model === "string") model = payload.model;

      const choices = Array.isArray(payload.choices) ? (payload.choices as Record<string, unknown>[]) : [];
      const choice = choices[0];
      if (!choice) continue;

      const delta = (choice.delta as Record<string, unknown> | undefined) ?? {};
      const finishReason = choice.finish_reason as string | null | undefined;

      // Text content deltas
      if (typeof delta.content === "string" && delta.content.length > 0) {
        emitTextBlockStart(controller);
        controller.enqueue(encodeChunk(JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: delta.content },
        }), "content_block_delta"));
      }

      // Tool call deltas
      const toolCalls = delta.tool_calls as Record<string, unknown>[] | undefined;
      if (Array.isArray(toolCalls)) {
        emitMessageStart(controller);
        for (const tc of toolCalls) {
          const tcIndex = typeof tc.index === "number" ? tc.index : 0;
          const fn = (tc.function as Record<string, unknown> | undefined) ?? {};

          if (tc.id && tc.type === "function") {
            // First chunk for this tool call — close text block if open
            emitTextBlockStop(controller);
            const blockIdx = contentBlockIndex++;
            activeToolCalls.set(tcIndex, { blockIndex: blockIdx });

            controller.enqueue(encodeChunk(JSON.stringify({
              type: "content_block_start",
              index: blockIdx,
              content_block: { type: "tool_use", id: tc.id, name: fn.name },
            }), "content_block_start"));

            // First chunk may also contain initial arguments
            if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
              controller.enqueue(encodeChunk(JSON.stringify({
                type: "content_block_delta",
                index: blockIdx,
                delta: { type: "input_json_delta", partial_json: fn.arguments },
              }), "content_block_delta"));
            }
          } else {
            // Subsequent chunk — incremental arguments
            const info = activeToolCalls.get(tcIndex);
            if (info && typeof fn.arguments === "string" && fn.arguments.length > 0) {
              controller.enqueue(encodeChunk(JSON.stringify({
                type: "content_block_delta",
                index: info.blockIndex,
                delta: { type: "input_json_delta", partial_json: fn.arguments },
              }), "content_block_delta"));
            }
          }
        }
      }

      if (finishReason) {
        emitMessageStart(controller);
        stop(controller, finishReason);
      }
    }
  }

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const text = decoder.decode(chunk, { stream: true });
      processEvents(parser.feed(text), controller);
    },
    flush(controller) {
      processEvents(parser.flush(), controller);
      if (messageStarted && !stopped) stop(controller, "stop");
    },
  });
}
