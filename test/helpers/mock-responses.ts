/**
 * Canned response payloads for OpenAI and Anthropic APIs.
 */

// ─── OpenAI ────────────────────────────────────────────────────────────────

export const OPENAI_TEXT_RESPONSE = {
  id: "chatcmpl-test123",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-2024-08-06",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "Hello from OpenAI!" },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

export const OPENAI_TOOL_CALL_RESPONSE = {
  id: "chatcmpl-tool456",
  object: "chat.completion",
  created: 1700000000,
  model: "gpt-4o-2024-08-06",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_abc123",
            type: "function",
            function: {
              name: "get_weather",
              arguments: '{"location":"San Francisco"}',
            },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
};

export const OPENAI_ERROR_500 = {
  error: { message: "Internal server error", type: "server_error", code: null },
};

export const OPENAI_ERROR_429 = {
  error: {
    message: "Rate limit reached",
    type: "tokens",
    code: "rate_limit_exceeded",
  },
};

// ─── Anthropic ─────────────────────────────────────────────────────────────

export const ANTHROPIC_TEXT_RESPONSE = {
  id: "msg_test789",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "Hello from Anthropic!" }],
  model: "claude-sonnet-4-5-20250929",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
};

export const ANTHROPIC_TOOL_USE_RESPONSE = {
  id: "msg_tool321",
  type: "message",
  role: "assistant",
  content: [
    {
      type: "tool_use",
      id: "toolu_abc123",
      name: "get_weather",
      input: { location: "San Francisco" },
    },
  ],
  model: "claude-sonnet-4-5-20250929",
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 20, output_tokens: 12 },
};

export const ANTHROPIC_ERROR_500 = {
  type: "error",
  error: { type: "api_error", message: "Internal server error" },
};

export const ANTHROPIC_ERROR_400 = {
  type: "error",
  error: { type: "invalid_request_error", message: "Invalid request" },
};

// ─── Response builders ─────────────────────────────────────────────────────

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
