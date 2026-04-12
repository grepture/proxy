import { TranslationNotSupportedError, type Format } from "./types";

type AnyRecord = Record<string, unknown>;

/**
 * Translate a non-streaming chat completion response from one provider format
 * to another. The caller's expected format becomes the target.
 */
export function translateResponse(
  source: Format,
  target: Format,
  body: unknown,
): AnyRecord {
  if (source === target) return body as AnyRecord;
  if (!body || typeof body !== "object") {
    throw new TranslationNotSupportedError("response body is not an object");
  }

  const src = body as AnyRecord;

  if (source === "anthropic" && target === "openai") {
    return anthropicResponseToOpenai(src);
  }
  if (source === "openai" && target === "anthropic") {
    return openaiResponseToAnthropic(src);
  }

  throw new TranslationNotSupportedError(`unsupported response translation: ${source} → ${target}`);
}

// ─── Anthropic → OpenAI ─────────────────────────────────────────────────────

function anthropicResponseToOpenai(src: AnyRecord): AnyRecord {
  const contentBlocks = Array.isArray(src.content) ? (src.content as AnyRecord[]) : [];
  const textBlocks = contentBlocks.filter((b) => b.type === "text" && typeof b.text === "string");
  const toolUseBlocks = contentBlocks.filter((b) => b.type === "tool_use");

  const text = textBlocks.map((b) => b.text as string).join("");
  const finishReason = mapAnthropicStopReason(src.stop_reason as string | null | undefined);

  const usageSrc = (src.usage as AnyRecord | undefined) ?? {};
  const promptTokens = typeof usageSrc.input_tokens === "number" ? usageSrc.input_tokens : 0;
  const completionTokens = typeof usageSrc.output_tokens === "number" ? usageSrc.output_tokens : 0;

  const srcId = typeof src.id === "string" ? src.id : "msg_unknown";
  const id = srcId.startsWith("msg_") ? `chatcmpl-${srcId.slice(4)}` : `chatcmpl-${srcId}`;

  const message: AnyRecord = {
    role: "assistant",
    content: toolUseBlocks.length > 0 && text.length === 0 ? null : text,
  };

  if (toolUseBlocks.length > 0) {
    message.tool_calls = toolUseBlocks.map((b) => ({
      id: b.id,
      type: "function",
      function: {
        name: b.name,
        arguments: typeof b.input === "object" ? JSON.stringify(b.input) : "{}",
      },
    }));
  }

  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: src.model ?? null,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

function mapAnthropicStopReason(reason: string | null | undefined): string {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "max_tokens":
      return "length";
    case "stop_sequence":
      return "stop";
    case "tool_use":
      return "tool_calls";
    default:
      return "stop";
  }
}

// ─── OpenAI → Anthropic ─────────────────────────────────────────────────────

function safeJsonParse(json: unknown): Record<string, unknown> {
  if (typeof json !== "string") return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function openaiResponseToAnthropic(src: AnyRecord): AnyRecord {
  const choices = Array.isArray(src.choices) ? (src.choices as AnyRecord[]) : [];
  const firstChoice = choices[0] ?? {};
  const message = (firstChoice.message as AnyRecord | undefined) ?? {};
  const textContent = typeof message.content === "string" ? message.content : "";
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as AnyRecord[]) : [];

  const stopReason = mapOpenaiFinishReason(firstChoice.finish_reason as string | null | undefined);

  const usageSrc = (src.usage as AnyRecord | undefined) ?? {};
  const inputTokens = typeof usageSrc.prompt_tokens === "number" ? usageSrc.prompt_tokens : 0;
  const outputTokens = typeof usageSrc.completion_tokens === "number" ? usageSrc.completion_tokens : 0;

  const srcId = typeof src.id === "string" ? src.id : "chatcmpl-unknown";
  const id = srcId.startsWith("chatcmpl-") ? `msg_${srcId.slice(9)}` : `msg_${srcId}`;

  const contentBlocks: AnyRecord[] = [];
  if (textContent.length > 0) {
    contentBlocks.push({ type: "text", text: textContent });
  }
  for (const tc of toolCalls) {
    const fn = (tc.function as AnyRecord | undefined) ?? {};
    contentBlocks.push({
      type: "tool_use",
      id: tc.id,
      name: fn.name,
      input: safeJsonParse(fn.arguments),
    });
  }
  if (contentBlocks.length === 0) {
    contentBlocks.push({ type: "text", text: "" });
  }

  return {
    id,
    type: "message",
    role: "assistant",
    content: contentBlocks,
    model: src.model ?? null,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    },
  };
}

function mapOpenaiFinishReason(reason: string | null | undefined): string {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "end_turn";
    default:
      return "end_turn";
  }
}
