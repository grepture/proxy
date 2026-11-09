export type StringTransform = (s: string) => Promise<string>;

// Keys that hold a provider-issued ID or reference wherever they appear (tool
// call pairing, files, containers, vector stores). Their whole value is left
// alone, including arrays and objects.
const ID_KEYS = new Set([
  "tool_use_id", "tool_call_id", "call_id", "approval_request_id", "previous_response_id",
  "file_id", "file_ids", "vector_store_ids", "container_id",
]);

// Provider references that are only exempt at the top of the request body,
// since the same names can be user data inside tool input.
const ROOT_ID_KEYS = new Set([
  "conversation", // OpenAI Responses
  "container", // Anthropic
  "cachedContent", // Gemini
  "prompt_cache_key", // OpenAI
]);

// Objects whose `id` is provider-issued, identified by the key they sit under
// because they have no `type`: Gemini function parts, and the OpenAI stored
// prompt at the top of the body.
const ID_PARENT_KEYS = new Set(["functionCall", "functionResponse", "$.prompt"]);

const ROOT = "$";

// Block and item types whose `id` is provider-issued. Anything else named `id`
// (e.g. inside tool `input`) may be user data and is still scanned. Responses
// item IDs (cmp_, rs_, msg_, fc_ ...) can contain long digit runs that look
// like phone numbers, and the API rejects a rewritten one.
const ID_BLOCK_TYPES = new Set([
  "tool_use", "server_tool_use", "mcp_tool_use", // Anthropic
  "function", // OpenAI chat tool_calls[]
  "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output", // OpenAI Responses
  "message", "reasoning", "compaction", "item_reference", // OpenAI Responses
  "web_search_call", "file_search_call", "computer_call", "computer_call_output",
  "code_interpreter_call", "image_generation_call", "local_shell_call", "local_shell_call_output",
  "mcp_call", "mcp_list_tools", "mcp_approval_request", "mcp_approval_response",
  "reasoning.text", "reasoning.summary", "reasoning.encrypted", // OpenRouter reasoning_details
]);

// Provider-issued opaque blobs (reasoning signatures, encrypted reasoning and
// compaction state). They are signed or encrypted by the provider and carry no
// readable text, but a PII pattern or find_replace regex can still match a
// run of base64 inside them; rewriting even one character makes the provider
// reject the replay ("Invalid signature", "could not be decrypted").
const OPAQUE_KEYS = new Set([
  "encrypted_content", // OpenAI Responses reasoning and compaction items, Anthropic web search results
  "encrypted_index", // Anthropic web search citations
  "thoughtSignature", "thought_signature", // Gemini
  "authorization_token", // Anthropic mcp_servers credentials
]);

// Keys that are opaque only on specific block types, since `signature`,
// `data`, `authorization` and `headers` are ordinary names elsewhere (e.g.
// inside tool input).
const OPAQUE_BLOCK_KEYS = new Map<string, string[]>([
  ["thinking", ["signature"]], // Anthropic
  ["redacted_thinking", ["data"]], // Anthropic
  ["reasoning.text", ["signature"]], // OpenRouter reasoning_details
  ["reasoning.encrypted", ["data"]], // OpenRouter reasoning_details
  ["mcp", ["authorization", "headers"]], // OpenAI remote MCP tool credentials
  ["code_interpreter", ["container"]], // OpenAI tool container ID or config
]);

/**
 * Walk only the string leaves of a parsed JSON value, applying `transform`.
 * Provider-issued IDs, opaque blobs and tool credentials are left untouched:
 * rewriting them breaks tool call pairing, signature checks or auth, which
 * providers reject.
 */
export function transformStrings(value: unknown, transform: StringTransform): Promise<unknown> {
  return walk(value, transform, ROOT);
}

/** `parentKey` is the key `value` sits under: ROOT for the body, `$.key` for its fields. */
async function walk(value: unknown, transform: StringTransform, parentKey: string | null): Promise<unknown> {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = await walk(value[i], transform, null);
    return out;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const type = typeof obj.type === "string" ? obj.type : "";
    const isRoot = parentKey === ROOT;
    const hasProviderId = ID_BLOCK_TYPES.has(type) || (parentKey !== null && ID_PARENT_KEYS.has(parentKey));
    const opaqueBlockKeys = OPAQUE_BLOCK_KEYS.get(type) ?? [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const isProviderId = ID_KEYS.has(k) || (isRoot && ROOT_ID_KEYS.has(k)) || (k === "id" && hasProviderId);
      const isOpaque = OPAQUE_KEYS.has(k) || opaqueBlockKeys.includes(k);
      out[k] = isProviderId || isOpaque ? v : await walk(v, transform, isRoot ? `${ROOT}.${k}` : k);
    }
    return out;
  }
  return value;
}
