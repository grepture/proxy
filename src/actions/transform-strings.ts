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

/**
 * Walk only the string leaves of a parsed JSON value, applying `transform`.
 * Tool call IDs are left untouched: rewriting them breaks the pairing between
 * a tool call and its result, which providers reject.
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
    const isToolBlock = typeof obj.type === "string" && TOOL_BLOCK_TYPES.has(obj.type);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const isToolId = TOOL_ID_KEYS.has(k) || (k === "id" && isToolBlock);
      out[k] = isToolId ? v : await transformStrings(v, transform);
    }
    return out;
  }
  return value;
}
