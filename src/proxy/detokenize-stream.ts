import type { TokenVault } from "../providers/types";
import { detokenize } from "../actions/tokenize";

/**
 * A streamed string fragment the model is generating. `channel` identifies the
 * logical field it belongs to (one content block, choice, or tool call), so a
 * token split across deltas is reassembled only within its own field. `json`
 * marks fragments of a JSON document (tool arguments), whose restored values
 * must be JSON-escaped.
 */
export interface StreamDelta {
  channel: string;
  text: string;
  json: boolean;
}

interface DeltaRef extends StreamDelta {
  set(json: Record<string, unknown>, text: string): void;
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Finds every generated string fragment in one parsed SSE payload. */
function findDeltas(json: Json): DeltaRef[] {
  const refs: DeltaRef[] = [];

  // OpenAI Responses API: { type: "response.*.delta", delta: "..." } covers
  // output text, refusals, reasoning text/summaries and function arguments.
  if (typeof json.delta === "string") {
    const type = typeof json.type === "string" ? json.type : "";
    const sub = json.content_index ?? json.summary_index ?? "";
    refs.push({
      channel: `r:${type}:${json.output_index ?? ""}:${sub}`,
      text: json.delta,
      json: type.endsWith("arguments.delta"),
      set: (j, t) => { j.delta = t; },
    });
    return refs;
  }

  // Anthropic: content_block_delta with text / partial_json / thinking.
  if (isObject(json.delta)) {
    const delta = json.delta;
    const block = `a:${json.index ?? 0}`;
    for (const field of ["text", "partial_json", "thinking"] as const) {
      const value = delta[field];
      if (typeof value !== "string") continue;
      refs.push({
        channel: `${block}:${field}`,
        text: value,
        json: field === "partial_json",
        set: (j, t) => { (j.delta as Json)[field] = t; },
      });
    }
    return refs;
  }

  // OpenAI Chat Completions (and compatible providers): content, reasoning
  // (reasoning_content / reasoning) and tool_calls[].function.arguments.
  if (Array.isArray(json.choices)) {
    json.choices.forEach((choice: unknown, ci: number) => {
      if (!isObject(choice) || !isObject(choice.delta)) return;
      const delta = choice.delta;
      const prefix = `o:${choice.index ?? ci}`;
      for (const field of ["content", "reasoning_content", "reasoning"] as const) {
        const value = delta[field];
        if (typeof value !== "string") continue;
        refs.push({
          channel: `${prefix}:${field}`,
          text: value,
          json: false,
          set: (j, t) => { ((j.choices as Json[])[ci].delta as Json)[field] = t; },
        });
      }
      // OpenRouter: reasoning_details[] carries the same reasoning as
      // `reasoning`, as text or summary entries. Signatures and encrypted
      // entries are left alone.
      if (Array.isArray(delta.reasoning_details)) {
        delta.reasoning_details.forEach((detail: unknown, di: number) => {
          if (!isObject(detail)) return;
          for (const field of ["text", "summary"] as const) {
            const value = detail[field];
            if (typeof value !== "string") continue;
            refs.push({
              channel: `${prefix}:rd:${detail.index ?? di}:${field}`,
              text: value,
              json: false,
              set: (j, t) => {
                const details = ((j.choices as Json[])[ci].delta as Json).reasoning_details as Json[];
                details[di][field] = t;
              },
            });
          }
        });
      }
      if (!Array.isArray(delta.tool_calls)) return;
      delta.tool_calls.forEach((call: unknown, ti: number) => {
        if (!isObject(call) || !isObject(call.function)) return;
        const args = call.function.arguments;
        if (typeof args !== "string") return;
        refs.push({
          channel: `${prefix}:tool:${call.index ?? ti}`,
          text: args,
          json: true,
          set: (j, t) => {
            const calls = ((j.choices as Json[])[ci].delta as Json).tool_calls as Json[];
            (calls[ti].function as Json).arguments = t;
          },
        });
      });
    });
  }
  return refs;
}

function parseData(eventBlock: string): { lines: string[]; index: number; json: Json } | null {
  const lines = eventBlock.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("data: ")) continue;
    const payload = lines[i].slice(6).trim();
    if (payload === "[DONE]") return null;
    try {
      const json: unknown = JSON.parse(payload);
      if (isObject(json)) return { lines, index: i, json };
    } catch {
      // Not parseable
    }
  }
  return null;
}

/** Extract the generated string fragments from an SSE event (Anthropic, OpenAI Chat, OpenAI Responses). */
export function extractDeltas(eventBlock: string): StreamDelta[] {
  const parsed = parseData(eventBlock);
  if (!parsed) return [];
  return findDeltas(parsed.json).map(({ channel, text, json }) => ({ channel, text, json }));
}

/** Rewrite the fragments of the given channels in an SSE event. */
function replaceDeltas(eventBlock: string, texts: Map<string, string>): string {
  const parsed = parseData(eventBlock);
  if (!parsed) return eventBlock;
  for (const ref of findDeltas(parsed.json)) {
    const text = texts.get(ref.channel);
    if (text !== undefined) ref.set(parsed.json, text);
  }
  parsed.lines[parsed.index] = "data: " + JSON.stringify(parsed.json);
  return parsed.lines.join("\n");
}

/** JSON-escapes a restored value for insertion inside a JSON string literal. */
export function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/** Check if accumulated text ends with a potential partial token */
export function endsWithPartialToken(
  text: string,
  tokenPrefixes: string[],
  maxTokenLen: number,
): boolean {
  if (!text) return false;
  for (const prefix of tokenPrefixes) {
    // Ends with partial prefix? (e.g. "p", "pi", "pii" for prefix "pii_")
    for (let i = 1; i <= prefix.length && i <= text.length; i++) {
      if (text.endsWith(prefix.slice(0, i))) return true;
    }
    // Ends with full prefix + partial UUID?
    for (let len = prefix.length + 1; len <= maxTokenLen && len <= text.length; len++) {
      const tail = text.slice(-len);
      if (tail.startsWith(prefix) && /^[0-9a-f-]*$/.test(tail.slice(prefix.length))) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Stricter check: does `text` end with an *incomplete* token still being built?
 *
 * Unlike endsWithPartialToken, this returns FALSE for a complete UUID at the
 * end — because a complete token doesn't need more chars to resolve, and
 * holding for it would only delay flush.
 *
 * This matters when a channel's text contains BOTH a complete token (earlier) AND
 * an incomplete one trailing. The old logic flushed eagerly on the complete
 * one and abandoned the trailing partial, causing it to emit raw across two
 * separate events. This function lets the caller keep holding instead.
 */
export function endsWithIncompleteToken(
  text: string,
  tokenPrefixes: string[],
): boolean {
  if (!text) return false;
  const UUID_LEN = 36; // 8-4-4-4-12 + 4 dashes
  for (const prefix of tokenPrefixes) {
    // Trailing partial prefix ("p", "pi", "pii" for "pii_")
    for (let i = 1; i < prefix.length && i <= text.length; i++) {
      if (text.endsWith(prefix.slice(0, i))) return true;
    }
    // Trailing full prefix + < 36 chars of valid UUID material
    const lastIdx = text.lastIndexOf(prefix);
    if (lastIdx === -1) continue;
    const after = text.slice(lastIdx + prefix.length);
    if (after.length < UUID_LEN && /^[0-9a-f-]*$/.test(after)) {
      return true;
    }
  }
  return false;
}

/**
 * Creates a TransformStream that detokenizes tokens in a streamed SSE response.
 *
 * LLMs output tokens character-by-character across many SSE events, so a simple
 * trailing-buffer approach can't detect them. Instead, this parses SSE events,
 * extracts text content, and holds events while a potential token is being formed.
 * When a complete token is found, it's looked up in the vault and the held events are
 * emitted with the original value restored.
 */
export function createDetokenizeStream(
  upstream: ReadableStream<Uint8Array>,
  teamId: string,
  tokenPrefixes: string[],
  vault: TokenVault,
): { stream: ReadableStream<Uint8Array>; accumulated: Promise<string> } {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let fullBody = "";
  let resolveAccumulated: (body: string) => void;
  const accumulated = new Promise<string>((resolve) => {
    resolveAccumulated = resolve;
  });

  // No token prefixes — passthrough, just accumulate for logging
  if (tokenPrefixes.length === 0) {
    const passthrough = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        fullBody += decoder.decode(chunk, { stream: true });
        controller.enqueue(chunk);
      },
      flush() {
        resolveAccumulated(fullBody);
      },
    });

    return {
      stream: upstream.pipeThrough(passthrough),
      accumulated,
    };
  }

  // --- SSE-aware detokenization ---

  const maxTokenLen = Math.max(...tokenPrefixes.map((p) => p.length)) + 36;

  // Token detection regex
  const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const escapedPrefixes = tokenPrefixes.map((p) =>
    p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const tokenRegex = new RegExp(
    `(?:${escapedPrefixes.join("|")})${uuidPattern}`,
  );

  let sseBuffer = ""; // Incomplete SSE data waiting for \n\n
  let heldEvents: string[] = []; // SSE events being held
  let heldChars = 0; // Generated characters across the held events
  // Generated text per channel across the held events, and whether that
  // channel is JSON-encoded (tool arguments).
  let pending = new Map<string, { text: string; json: boolean }>();

  // Responses API terminal events (response.*.done, response.completed) carry
  // the full final text, arguments and reasoning in nested fields the delta
  // walker doesn't know about. Clients like TypingMind read from these events
  // and overwrite whatever the deltas rendered, so any tokens here would leak
  // even if every delta was detokenized correctly.
  function isResponsesTerminalEvent(json: Json): boolean {
    const type = json.type;
    if (typeof type !== "string" || !type.startsWith("response.")) return false;
    return type.endsWith(".done") || type === "response.completed" || type === "response.incomplete";
  }

  /** Detokenize every string in a parsed event; `arguments` hold JSON text. */
  async function detokenizeValue(value: unknown, key: string | null): Promise<unknown> {
    if (typeof value === "string") {
      if (!tokenRegex.test(value)) return value;
      return detokenize(value, teamId, tokenPrefixes, vault, key === "arguments" ? jsonEscape : undefined);
    }
    if (Array.isArray(value)) {
      return Promise.all(value.map((v) => detokenizeValue(v, null)));
    }
    if (isObject(value)) {
      const out: Json = {};
      for (const [k, v] of Object.entries(value)) out[k] = await detokenizeValue(v, k);
      return out;
    }
    return value;
  }

  /** If `block` is a Responses terminal event, returns it detokenized; else null. */
  async function detokenizeTerminal(block: string): Promise<string | null> {
    const parsed = parseData(block);
    if (!parsed || !isResponsesTerminalEvent(parsed.json)) return null;
    if (!tokenRegex.test(block)) return block;
    parsed.lines[parsed.index] = "data: " + JSON.stringify(await detokenizeValue(parsed.json, null));
    return parsed.lines.join("\n");
  }

  function emit(controller: TransformStreamDefaultController<Uint8Array>, eventBlock: string) {
    const data = eventBlock + "\n\n";
    fullBody += data;
    controller.enqueue(encoder.encode(data));
  }

  function hold(block: string) {
    heldEvents.push(block);
    for (const delta of extractDeltas(block)) {
      heldChars += delta.text.length;
      const entry = pending.get(delta.channel);
      if (entry) entry.text += delta.text;
      else pending.set(delta.channel, { text: delta.text, json: delta.json });
    }
  }

  function anyIncomplete(): boolean {
    for (const { text } of pending.values()) {
      if (endsWithIncompleteToken(text, tokenPrefixes)) return true;
    }
    return false;
  }

  async function flushHeld(controller: TransformStreamDefaultController<Uint8Array>) {
    if (heldEvents.length === 0) return;

    // Detokenize each channel's merged text. A channel with a token gets its
    // whole restored text in its last held event, and empty strings in the
    // earlier ones, so a token split across deltas is replaced intact.
    const restored = new Map<string, string>();
    for (const [channel, { text, json }] of pending) {
      if (!tokenRegex.test(text)) continue;
      restored.set(channel, await detokenize(text, teamId, tokenPrefixes, vault, json ? jsonEscape : undefined));
    }

    if (restored.size === 0) {
      for (const event of heldEvents) emit(controller, event);
    } else {
      const lastIdx = new Map<string, number>();
      heldEvents.forEach((event, i) => {
        for (const { channel } of extractDeltas(event)) lastIdx.set(channel, i);
      });
      heldEvents.forEach((event, i) => {
        const texts = new Map<string, string>();
        for (const { channel } of extractDeltas(event)) {
          const text = restored.get(channel);
          if (text !== undefined) texts.set(channel, lastIdx.get(channel) === i ? text : "");
        }
        emit(controller, texts.size > 0 ? replaceDeltas(event, texts) : event);
      });
    }

    heldEvents = [];
    heldChars = 0;
    pending = new Map();
  }

  // Safety limits against unbounded holding. Characters, not events: an
  // upstream may spread one token over many tiny (or empty) events, but a
  // channel only stays incomplete while its trailing candidate is shorter
  // than a token, so a lot of held text means another channel is streaming
  // past a stalled one. The event cap only bounds memory for streams of
  // events that carry no text.
  const MAX_HELD_CHARS = 4096;
  const MAX_HELD_EVENTS = 1000;

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      try {
        sseBuffer += decoder.decode(chunk, { stream: true });

        // Split on double newline to get complete SSE events
        const parts = sseBuffer.split("\n\n");
        sseBuffer = parts.pop()!; // Keep the incomplete tail

        for (const block of parts) {
          const trimmed = block.trim();
          if (!trimmed) continue;

          // Terminal Responses events carry the full final text. Flush any
          // pending deltas first, then emit the detokenized event.
          const terminal = await detokenizeTerminal(trimmed);
          if (terminal !== null) {
            await flushHeld(controller);
            emit(controller, terminal);
            continue;
          }

          hold(trimmed);

          // Decide: flush or keep holding.
          //
          // Hold as long as any channel has an *incomplete* trailing token that
          // might still complete in a future delta — even if it already
          // contains earlier complete tokens. Flushing on the earlier complete
          // one would abandon the trailing partial and emit it raw across the
          // boundary.
          //
          // The held limits are the safety valve: if a trailing run never
          // resolves while other output keeps arriving, flush regardless.
          if (heldChars >= MAX_HELD_CHARS || heldEvents.length >= MAX_HELD_EVENTS) {
            await flushHeld(controller);
          } else if (!anyIncomplete()) {
            await flushHeld(controller);
          }
          // else: incomplete token at end — keep holding
        }
      } catch (err) {
        console.error("Detokenize stream error:", err);
        for (const event of heldEvents) {
          emit(controller, event);
        }
        heldEvents = [];
        heldChars = 0;
        pending = new Map();
      }
    },

    async flush(controller) {
      try {
        if (sseBuffer.trim()) {
          const trimmed = sseBuffer.trim();
          const terminal = await detokenizeTerminal(trimmed);
          if (terminal !== null) {
            await flushHeld(controller);
            emit(controller, terminal);
          } else {
            hold(trimmed);
          }
        }
        await flushHeld(controller);
        resolveAccumulated(fullBody);
      } catch (err) {
        for (const event of heldEvents) {
          emit(controller, event);
        }
        resolveAccumulated(fullBody);
        console.error("Detokenize stream flush error:", err);
      }
    },
  });

  return {
    stream: upstream.pipeThrough(transform),
    accumulated,
  };
}
