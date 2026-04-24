import { TranslationNotSupportedError, type Format } from "./types";

type AnyRecord = Record<string, unknown>;

export type ExtractedToolUse = {
  id: string;
  name: string;
  input: AnyRecord;
  /** Which shape produced this — useful for setting the `provider` column. */
  shape: "anthropic" | "openai_chat" | "openai_responses" | "openai_stream" | "anthropic_stream";
};

function providerFromShape(shape: ExtractedToolUse["shape"]): "openai" | "anthropic" {
  return shape === "anthropic" || shape === "anthropic_stream" ? "anthropic" : "openai";
}

export function providerForRow(uses: ExtractedToolUse[]): "openai" | "anthropic" | null {
  if (uses.length === 0) return null;
  return providerFromShape(uses[0].shape);
}

function safeJsonParseObj(raw: unknown): AnyRecord {
  if (typeof raw !== "string") return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as AnyRecord) : {};
  } catch {
    return {};
  }
}

/**
 * Extract tool_use calls from an LLM response. Tries all known shapes
 * (Anthropic messages, OpenAI Chat Completions, OpenAI Responses API, and
 * SSE streams of either). The shape is detected from the parsed body; SSE
 * is detected from the raw body text. Falls back to object-by-object
 * scanning when the body is truncated (`response_body` is capped at 50KB
 * in traffic_logs). Returns [] when no tool calls are present.
 */
export function extractToolUses(parsedBody: unknown, rawBody?: string | null): ExtractedToolUse[] {
  // --- SSE stream path ---
  if (typeof rawBody === "string" && rawBody.includes("data: ")) {
    return extractToolUsesFromSSE(rawBody);
  }

  // --- Truncated-body fallback: scan for complete `{"type":"function_call", ...}`
  // objects inside a partially-stored array. This recovers tool calls even
  // when JSON.parse fails on the whole body. ---
  if (!parsedBody && typeof rawBody === "string" && rawBody.includes("\"function_call\"")) {
    const objects = scanJsonObjects(rawBody);
    const out: ExtractedToolUse[] = [];
    for (const obj of objects) {
      if (obj.type !== "function_call") continue;
      const id = typeof obj.call_id === "string" ? obj.call_id : (typeof obj.id === "string" ? obj.id : null);
      if (!id || typeof obj.name !== "string") continue;
      const input = typeof obj.arguments === "string"
        ? safeJsonParseObj(obj.arguments)
        : (obj.arguments && typeof obj.arguments === "object" ? (obj.arguments as AnyRecord) : {});
      out.push({ id, name: obj.name, input, shape: "openai_responses" });
    }
    if (out.length > 0) return out;
  }

  if (!parsedBody || typeof parsedBody !== "object") return [];
  const src = parsedBody as AnyRecord;

  // --- Anthropic Messages: { role: "assistant", content: [{type: "tool_use", ...}] } ---
  if (Array.isArray(src.content)) {
    const blocks = src.content as AnyRecord[];
    const out: ExtractedToolUse[] = [];
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      if (typeof b.id !== "string" || typeof b.name !== "string") continue;
      out.push({
        id: b.id,
        name: b.name,
        input: (b.input && typeof b.input === "object" ? (b.input as AnyRecord) : {}),
        shape: "anthropic",
      });
    }
    if (out.length > 0) return out;
  }

  // --- OpenAI Responses API: { output: [{type: "function_call", call_id, name, arguments}] } ---
  if (Array.isArray(src.output)) {
    const entries = src.output as AnyRecord[];
    const out: ExtractedToolUse[] = [];
    for (const e of entries) {
      if (e.type !== "function_call") continue;
      const id = typeof e.call_id === "string" ? e.call_id : (typeof e.id === "string" ? e.id : null);
      if (!id || typeof e.name !== "string") continue;
      const input = typeof e.arguments === "string"
        ? safeJsonParseObj(e.arguments)
        : (e.arguments && typeof e.arguments === "object" ? (e.arguments as AnyRecord) : {});
      out.push({ id, name: e.name, input, shape: "openai_responses" });
    }
    if (out.length > 0) return out;
  }

  // --- OpenAI Chat Completions: { choices: [{message: {tool_calls: [...]}}] } ---
  if (Array.isArray(src.choices)) {
    const firstChoice = (src.choices as AnyRecord[])[0] ?? {};
    const message = (firstChoice.message as AnyRecord | undefined) ?? {};
    const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as AnyRecord[]) : [];
    const out: ExtractedToolUse[] = [];
    for (const tc of toolCalls) {
      if (typeof tc.id !== "string") continue;
      const fn = (tc.function as AnyRecord | undefined) ?? {};
      if (typeof fn.name !== "string") continue;
      out.push({
        id: tc.id,
        name: fn.name,
        input: safeJsonParseObj(fn.arguments),
        shape: "openai_chat",
      });
    }
    if (out.length > 0) return out;
  }

  return [];
}

// ─── Truncation-tolerant JSON object scanner ──────────────────────────────
//
// Walks `body` character by character tracking brace depth so that
// truncation mid-object doesn't prevent us from extracting earlier objects.
// Mirrors the logic in app/.../prompt-inspector.tsx used by the trace viewer.

function scanJsonObjects(body: string): AnyRecord[] {
  const out: AnyRecord[] = [];
  let i = 0;
  while (i < body.length) {
    const objStart = body.indexOf("{", i);
    if (objStart === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let objEnd = -1;

    for (let j = objStart; j < body.length; j++) {
      const ch = body[j];
      if (escaped) { escaped = false; continue; }
      if (ch === "\\") { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { objEnd = j; break; } }
    }

    if (objEnd === -1) {
      // Outer object never balances (body truncated mid-object). Skip past
      // this `{` and keep scanning — any balanced INNER objects (the array
      // elements we actually care about) will still be found.
      i = objStart + 1;
      continue;
    }

    try {
      const parsed = JSON.parse(body.slice(objStart, objEnd + 1));
      if (parsed && typeof parsed === "object") out.push(parsed as AnyRecord);
    } catch { /* skip malformed */ }
    i = objEnd + 1;
  }
  return out;
}

// ─── SSE stream extraction ─────────────────────────────────────────────────
//
// Mirrors `reassembleStream` in app/.../prompt-inspector.tsx so the live
// streaming path and the backfill both find the same tool calls. OpenAI
// streams Chat Completions deltas; Anthropic streams content_block_start /
// content_block_delta events. Both accumulate arguments incrementally.

function extractToolUsesFromSSE(sseText: string): ExtractedToolUse[] {
  const oai = new Map<number, { id: string; name: string; args: string }>();
  const ant = new Map<number, { id: string; name: string; args: string }>();
  // Responses API streaming uses output_item.added / response.function_call_arguments.delta
  const resp = new Map<string, { id: string; name: string; args: string }>();

  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    let data: AnyRecord;
    try {
      data = JSON.parse(payload.replace(/\[[\w_]+_REDACTED\]/g, '"[redacted]"')) as AnyRecord;
    } catch { continue; }

    // OpenAI Chat Completions streaming
    const choices = Array.isArray(data.choices) ? (data.choices as AnyRecord[]) : null;
    if (choices) {
      const delta = (choices[0]?.delta as AnyRecord | undefined) ?? null;
      if (delta && Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls as AnyRecord[]) {
          const idx = typeof tc.index === "number" ? tc.index : 0;
          const existing = oai.get(idx);
          const fn = (tc.function as AnyRecord | undefined) ?? {};
          if (!existing) {
            oai.set(idx, {
              id: typeof tc.id === "string" ? tc.id : "",
              name: typeof fn.name === "string" ? fn.name : "",
              args: typeof fn.arguments === "string" ? fn.arguments : "",
            });
          } else {
            if (typeof tc.id === "string" && tc.id) existing.id = tc.id;
            if (typeof fn.name === "string" && fn.name) existing.name = fn.name;
            if (typeof fn.arguments === "string") existing.args += fn.arguments;
          }
        }
      }
      continue;
    }

    // Anthropic streaming
    if (data.type === "content_block_start") {
      const cb = data.content_block as AnyRecord | undefined;
      if (cb && cb.type === "tool_use") {
        const idx = typeof data.index === "number" ? data.index : ant.size;
        ant.set(idx, {
          id: typeof cb.id === "string" ? cb.id : "",
          name: typeof cb.name === "string" ? cb.name : "",
          args: "",
        });
      }
    } else if (data.type === "content_block_delta") {
      const delta = data.delta as AnyRecord | undefined;
      if (delta && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const idx = typeof data.index === "number" ? data.index : 0;
        const existing = ant.get(idx);
        if (existing) existing.args += delta.partial_json;
      }
    }

    // OpenAI Responses API streaming
    else if (data.type === "response.output_item.added") {
      const item = data.item as AnyRecord | undefined;
      if (item && item.type === "function_call") {
        const key = typeof item.id === "string" ? item.id : `idx_${resp.size}`;
        resp.set(key, {
          id: typeof item.call_id === "string" ? item.call_id : (typeof item.id === "string" ? item.id : ""),
          name: typeof item.name === "string" ? item.name : "",
          args: typeof item.arguments === "string" ? item.arguments : "",
        });
      }
    } else if (data.type === "response.function_call_arguments.delta") {
      const key = typeof data.item_id === "string" ? data.item_id : null;
      if (key) {
        const existing = resp.get(key);
        if (existing && typeof data.delta === "string") existing.args += data.delta;
      }
    }
  }

  const out: ExtractedToolUse[] = [];
  for (const [, v] of oai) {
    if (!v.id || !v.name) continue;
    out.push({ id: v.id, name: v.name, input: safeJsonParseObj(v.args), shape: "openai_stream" });
  }
  for (const [, v] of ant) {
    if (!v.id || !v.name) continue;
    out.push({ id: v.id, name: v.name, input: safeJsonParseObj(v.args), shape: "anthropic_stream" });
  }
  for (const [, v] of resp) {
    if (!v.id || !v.name) continue;
    out.push({ id: v.id, name: v.name, input: safeJsonParseObj(v.args), shape: "openai_stream" });
  }
  return out;
}

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
