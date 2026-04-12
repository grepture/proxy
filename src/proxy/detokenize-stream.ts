import type { TokenVault } from "../providers/types";
import { detokenize } from "../actions/tokenize";

/** Extract text content from an SSE event's data payload (Anthropic + OpenAI) */
export function extractText(eventBlock: string): string | null {
  for (const line of eventBlock.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (payload === "[DONE]") return null;
    try {
      const json = JSON.parse(payload);
      if (json.delta?.text !== undefined) return json.delta.text;
      const content = json.choices?.[0]?.delta?.content;
      if (content !== undefined) return content;
    } catch {
      // Not parseable
    }
  }
  return null;
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
  let pendingText = ""; // Accumulated text content from held events
  let heldEvents: string[] = []; // SSE events being held

  /** Replace text content in an SSE event's JSON payload */
  function replaceTextInEvent(eventBlock: string, newText: string): string {
    const lines = eventBlock.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("data: ")) continue;
      try {
        const json = JSON.parse(lines[i].slice(6));
        if (json.delta?.text !== undefined) {
          json.delta.text = newText;
        } else if (json.choices?.[0]?.delta?.content !== undefined) {
          json.choices[0].delta.content = newText;
        } else {
          continue;
        }
        lines[i] = "data: " + JSON.stringify(json);
        return lines.join("\n");
      } catch {
        continue;
      }
    }
    return eventBlock;
  }

  function emit(controller: TransformStreamDefaultController<Uint8Array>, eventBlock: string) {
    const data = eventBlock + "\n\n";
    fullBody += data;
    controller.enqueue(encoder.encode(data));
  }

  async function flushHeld(controller: TransformStreamDefaultController<Uint8Array>) {
    if (heldEvents.length === 0) return;

    const hasToken = tokenRegex.test(pendingText);

    if (hasToken) {
      const detokenized = await detokenize(pendingText, teamId, tokenPrefixes, vault);

      // Find the last text event to use as the template for emitting merged text
      let lastTextIdx = -1;
      for (let i = heldEvents.length - 1; i >= 0; i--) {
        if (extractText(heldEvents[i]) !== null) {
          lastTextIdx = i;
          break;
        }
      }

      for (let i = 0; i < heldEvents.length; i++) {
        const isTextEvent = extractText(heldEvents[i]) !== null;
        if (isTextEvent && i === lastTextIdx) {
          // Emit the merged detokenized text in this event
          emit(controller, replaceTextInEvent(heldEvents[i], detokenized));
        } else if (isTextEvent) {
          // Skip — content merged into the last text event
          continue;
        } else {
          // Non-text event (ping, message_start, etc.) — pass through
          emit(controller, heldEvents[i]);
        }
      }
    } else {
      // No tokens found — emit all as-is
      for (const event of heldEvents) {
        emit(controller, event);
      }
    }

    heldEvents = [];
    pendingText = "";
  }

  const MAX_HELD = 30; // Safety limit to prevent unbounded holding

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

          const text = extractText(trimmed);
          heldEvents.push(trimmed);
          if (text !== null) pendingText += text;

          // Decide: flush or keep holding
          const hasCompleteToken = tokenRegex.test(pendingText);

          if (hasCompleteToken) {
            await flushHeld(controller);
          } else if (heldEvents.length >= MAX_HELD) {
            await flushHeld(controller);
          } else if (!endsWithPartialToken(pendingText, tokenPrefixes, maxTokenLen)) {
            await flushHeld(controller);
          }
          // else: partial token at end — keep holding
        }
      } catch (err) {
        console.error("Detokenize stream error:", err);
        for (const event of heldEvents) {
          emit(controller, event);
        }
        heldEvents = [];
        pendingText = "";
      }
    },

    async flush(controller) {
      try {
        if (sseBuffer.trim()) {
          const text = extractText(sseBuffer.trim());
          heldEvents.push(sseBuffer.trim());
          if (text !== null) pendingText += text;
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
