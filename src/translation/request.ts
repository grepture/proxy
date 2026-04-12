import { TranslationNotSupportedError, type Format } from "./types";

// Default max_tokens when an OpenAI request without max_tokens is translated
// to Anthropic (which requires it). Conservative middle-ground value.
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;

type AnyRecord = Record<string, unknown>;

/**
 * Translate a chat completion request body from one provider format to another.
 * The `model` parameter overrides whatever is in the body — typically the
 * fallback key's `default_model`.
 *
 * Throws TranslationNotSupportedError when the request uses features that
 * cannot be safely translated (tool calls, function calling).
 */
export function translateRequest(
  source: Format,
  target: Format,
  body: unknown,
  model: string,
): AnyRecord {
  if (source === target) {
    // Identity — but still inject the model override
    const out = { ...(body as AnyRecord) };
    out.model = model;
    return out;
  }

  if (!body || typeof body !== "object") {
    throw new TranslationNotSupportedError("request body is not an object");
  }

  const src = body as AnyRecord;

  if (source === "openai" && target === "anthropic") {
    return openaiToAnthropic(src, model);
  }
  if (source === "anthropic" && target === "openai") {
    return anthropicToOpenai(src, model);
  }

  throw new TranslationNotSupportedError(`unsupported translation: ${source} → ${target}`);
}

// ─── Tool helpers ───────────────────────────────────────────────────────────

function translateToolsOpenaiToAnthropic(tools: AnyRecord[]): AnyRecord[] {
  return tools
    .filter((t) => t.type === "function" && t.function && typeof t.function === "object")
    .map((t) => {
      const fn = t.function as AnyRecord;
      return { name: fn.name, description: fn.description, input_schema: fn.parameters };
    });
}

function translateToolsAnthropicToOpenai(tools: AnyRecord[]): AnyRecord[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

function translateToolChoiceOpenaiToAnthropic(choice: unknown): AnyRecord {
  if (typeof choice === "string") {
    if (choice === "required") return { type: "any" };
    return { type: choice }; // "auto" | "none"
  }
  if (choice && typeof choice === "object") {
    const c = choice as AnyRecord;
    const fn = c.function as AnyRecord | undefined;
    if (fn && typeof fn.name === "string") return { type: "tool", name: fn.name };
  }
  return { type: "auto" };
}

function translateToolChoiceAnthropicToOpenai(choice: AnyRecord): unknown {
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "any":
      return "required";
    case "tool":
      return { type: "function", function: { name: choice.name } };
    default:
      return "auto";
  }
}

function safeJsonParse(json: unknown): AnyRecord {
  if (typeof json !== "string") return {};
  try {
    return JSON.parse(json) as AnyRecord;
  } catch {
    return {};
  }
}

// ─── OpenAI → Anthropic ─────────────────────────────────────────────────────

function openaiToAnthropic(src: AnyRecord, model: string): AnyRecord {
  const messages = Array.isArray(src.messages) ? (src.messages as AnyRecord[]) : [];

  // Anthropic has no "system" role in messages — collect all system messages
  // into the top-level system field.
  const systemParts: string[] = [];
  const nonSystemMessages: AnyRecord[] = [];

  for (const m of messages) {
    if (m.role === "system" && typeof m.content === "string") {
      systemParts.push(m.content);
    } else if (m.role === "assistant") {
      const toolCalls = Array.isArray(m.tool_calls) ? (m.tool_calls as AnyRecord[]) : [];
      if (toolCalls.length > 0) {
        // Assistant message with tool calls → content blocks
        const contentBlocks: AnyRecord[] = [];
        if (typeof m.content === "string" && m.content.length > 0) {
          contentBlocks.push({ type: "text", text: m.content });
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
        nonSystemMessages.push({ role: "assistant", content: contentBlocks });
      } else if (typeof m.content === "string") {
        nonSystemMessages.push({ role: "assistant", content: m.content });
      } else if (Array.isArray(m.content)) {
        // Already-structured content blocks — pass through
        nonSystemMessages.push({ role: "assistant", content: m.content });
      }
    } else if (m.role === "tool") {
      // Tool result → merge into a user message with tool_result blocks.
      // Anthropic requires alternating roles, so consecutive tool messages
      // must be merged into one user message.
      const resultBlock: AnyRecord = {
        type: "tool_result",
        tool_use_id: m.tool_call_id,
        content: typeof m.content === "string" ? m.content : "",
      };
      const last = nonSystemMessages[nonSystemMessages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Append to existing tool-result user message
        (last.content as AnyRecord[]).push(resultBlock);
      } else {
        nonSystemMessages.push({ role: "user", content: [resultBlock] });
      }
    } else if (m.role === "user") {
      if (typeof m.content === "string") {
        nonSystemMessages.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        nonSystemMessages.push({ role: "user", content: m.content });
      }
    }
  }

  const out: AnyRecord = {
    model,
    messages: nonSystemMessages,
    max_tokens: typeof src.max_tokens === "number" ? src.max_tokens : DEFAULT_ANTHROPIC_MAX_TOKENS,
  };

  if (systemParts.length > 0) {
    out.system = systemParts.join("\n\n");
  }
  if (typeof src.temperature === "number") out.temperature = src.temperature;
  if (typeof src.top_p === "number") out.top_p = src.top_p;
  if (src.stream === true) out.stream = true;

  // stop → stop_sequences
  if (typeof src.stop === "string") {
    out.stop_sequences = [src.stop];
  } else if (Array.isArray(src.stop)) {
    out.stop_sequences = src.stop;
  }

  // Tools
  if (Array.isArray(src.tools) && src.tools.length > 0) {
    out.tools = translateToolsOpenaiToAnthropic(src.tools as AnyRecord[]);
  }
  if (src.tool_choice !== undefined) {
    out.tool_choice = translateToolChoiceOpenaiToAnthropic(src.tool_choice);
  }

  // Dropped fields: n, seed, logprobs, top_logprobs, response_format,
  // frequency_penalty, presence_penalty, logit_bias, user, parallel_tool_calls

  return out;
}

// ─── Anthropic → OpenAI ─────────────────────────────────────────────────────

function anthropicToOpenai(src: AnyRecord, model: string): AnyRecord {
  const messages: AnyRecord[] = [];

  // Move top-level system → first system message
  if (typeof src.system === "string" && src.system.length > 0) {
    messages.push({ role: "system", content: src.system });
  } else if (Array.isArray(src.system)) {
    const text = (src.system as AnyRecord[])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("\n\n");
    if (text) messages.push({ role: "system", content: text });
  }

  // Append user/assistant messages
  if (Array.isArray(src.messages)) {
    for (const m of src.messages as AnyRecord[]) {
      if (m.role === "assistant") {
        if (Array.isArray(m.content)) {
          const blocks = m.content as AnyRecord[];
          const textBlocks = blocks.filter((b) => b.type === "text" && typeof b.text === "string");
          const toolUseBlocks = blocks.filter((b) => b.type === "tool_use");

          if (toolUseBlocks.length > 0) {
            // Assistant message with tool_use blocks → tool_calls
            const textContent = textBlocks.map((b) => b.text as string).join("");
            const toolCalls = toolUseBlocks.map((b) => ({
              id: b.id,
              type: "function",
              function: {
                name: b.name,
                arguments: typeof b.input === "object" ? JSON.stringify(b.input) : "{}",
              },
            }));
            messages.push({
              role: "assistant",
              content: textContent || null,
              tool_calls: toolCalls,
            });
          } else {
            // Text-only assistant message
            const text = textBlocks.map((b) => b.text as string).join("");
            messages.push({ role: "assistant", content: text });
          }
        } else if (typeof m.content === "string") {
          messages.push({ role: "assistant", content: m.content });
        }
      } else if (m.role === "user") {
        if (Array.isArray(m.content)) {
          const blocks = m.content as AnyRecord[];
          const toolResultBlocks = blocks.filter((b) => b.type === "tool_result");
          const textBlocks = blocks.filter((b) => b.type === "text" && typeof b.text === "string");

          // Emit tool results as separate tool-role messages
          for (const tr of toolResultBlocks) {
            let resultContent = "";
            if (typeof tr.content === "string") {
              resultContent = tr.content;
            } else if (Array.isArray(tr.content)) {
              resultContent = (tr.content as AnyRecord[])
                .filter((b) => b.type === "text" && typeof b.text === "string")
                .map((b) => b.text as string)
                .join("");
            }
            messages.push({ role: "tool", tool_call_id: tr.tool_use_id, content: resultContent });
          }

          // Emit remaining text as a user message
          if (textBlocks.length > 0) {
            const text = textBlocks.map((b) => b.text as string).join("");
            messages.push({ role: "user", content: text });
          }
        } else if (typeof m.content === "string") {
          messages.push({ role: "user", content: m.content });
        }
      }
    }
  }

  const out: AnyRecord = {
    model,
    messages,
  };

  if (typeof src.max_tokens === "number") out.max_tokens = src.max_tokens;
  if (typeof src.temperature === "number") out.temperature = src.temperature;
  if (typeof src.top_p === "number") out.top_p = src.top_p;
  if (src.stream === true) out.stream = true;

  // stop_sequences → stop
  if (Array.isArray(src.stop_sequences) && src.stop_sequences.length > 0) {
    out.stop = src.stop_sequences;
  }

  // Tools
  if (Array.isArray(src.tools) && src.tools.length > 0) {
    out.tools = translateToolsAnthropicToOpenai(src.tools as AnyRecord[]);
  }
  if (src.tool_choice !== undefined) {
    out.tool_choice = translateToolChoiceAnthropicToOpenai(src.tool_choice as AnyRecord);
  }

  // Dropped fields: top_k, metadata

  return out;
}
