export type StringTransform = (s: string) => Promise<string>;

// Keys that always hold a tool call ID (Anthropic tool_result, OpenAI chat
// tool messages, OpenAI Responses function_call / function_call_output).
const TOOL_ID_KEYS = new Set(["tool_use_id", "tool_call_id", "call_id"]);

// Block types whose `id` is a provider-issued tool call ID. Anything else named
// `id` (e.g. inside tool `input`) may be user data and is still scanned.
const TOOL_BLOCK_TYPES = new Set([
  "tool_use", "server_tool_use", "mcp_tool_use", // Anthropic
  "function", // OpenAI chat tool_calls[]
  "function_call", "custom_tool_call", // OpenAI Responses
]);

// Provider-issued opaque blobs (reasoning signatures, encrypted reasoning and
// compaction state). They are signed or encrypted by the provider and carry no
// readable text, but a PII pattern or find_replace regex can still match a
// run of base64 inside them; rewriting even one character makes the provider
// reject the replay ("Invalid signature", "could not be decrypted").
const OPAQUE_KEYS = new Set([
  "encrypted_content", // OpenAI Responses reasoning and compaction items
  "thoughtSignature", "thought_signature", // Gemini
]);

// Keys that are opaque only on specific block types, since `signature` and
// `data` are ordinary names elsewhere (e.g. inside tool input).
const OPAQUE_BLOCK_KEYS: Record<string, string> = {
  thinking: "signature", // Anthropic
  redacted_thinking: "data", // Anthropic
  "reasoning.text": "signature", // OpenRouter reasoning_details
  "reasoning.encrypted": "data", // OpenRouter reasoning_details
};

/**
 * Walk only the string leaves of a parsed JSON value, applying `transform`.
 * Tool call IDs and provider-issued opaque blobs are left untouched: rewriting
 * them breaks tool call pairing or signature checks, which providers reject.
 */
export async function transformStrings(value: unknown, transform: StringTransform): Promise<unknown> {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = await transformStrings(value[i], transform);
    return out;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    const isToolBlock = TOOL_BLOCK_TYPES.has(type);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const isToolId = TOOL_ID_KEYS.has(k) || (k === "id" && isToolBlock);
      const isOpaque = OPAQUE_KEYS.has(k) || OPAQUE_BLOCK_KEYS[type] === k;
      out[k] = isToolId || isOpaque ? v : await transformStrings(v, transform);
    }
    return out;
  }
  return value;
}
