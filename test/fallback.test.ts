import { describe, it, expect, afterEach } from "bun:test";
import type { ResolvedProviderKey } from "../src/providers/types";
import { createTestProviders } from "./helpers/test-providers";
import { createTestApp, resetProviders } from "./helpers/create-test-app";
import { installMockFetch } from "./helpers/mock-fetch";
import {
  OPENAI_TEXT_RESPONSE,
  OPENAI_TOOL_CALL_RESPONSE,
  OPENAI_ERROR_500,
  OPENAI_ERROR_429,
  ANTHROPIC_TEXT_RESPONSE,
  ANTHROPIC_TOOL_USE_RESPONSE,
  ANTHROPIC_ERROR_500,
  ANTHROPIC_ERROR_400,
  jsonResponse,
} from "./helpers/mock-responses";

// ─── Key chain: OpenAI primary → Anthropic fallback ────────────────────────

const OPENAI_KEY: ResolvedProviderKey = {
  id: "key-openai-1",
  provider: "openai",
  decrypted: "sk-test-openai",
  default_model: null,
  fallback_key_id: "key-anthropic-1",
};

const ANTHROPIC_KEY: ResolvedProviderKey = {
  id: "key-anthropic-1",
  provider: "anthropic",
  decrypted: "sk-ant-test",
  default_model: "claude-sonnet-4-5-20250929",
  fallback_key_id: null,
};

function makeApp() {
  return createTestApp(createTestProviders([OPENAI_KEY, ANTHROPIC_KEY]));
}

function makeRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-grepture-key",
      "X-Grepture-Target": "https://api.openai.com/v1/chat/completions",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
      ...body,
    }),
  });
}

let mockRestore: (() => void) | null = null;

afterEach(() => {
  mockRestore?.();
  mockRestore = null;
  resetProviders();
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe("fallback: primary succeeds", () => {
  it("returns OpenAI response without fallback", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.choices[0].message.content).toBe("Hello from OpenAI!");
    // Only one fetch call — no fallback
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].url).toContain("openai.com");
  });
});

describe("fallback: primary 500, Anthropic fallback succeeds", () => {
  it("translates response back to OpenAI format", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_ERROR_500, 500) },
      { match: (u) => u.includes("anthropic.com"), respond: () => jsonResponse(ANTHROPIC_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Response should be in OpenAI format (translated from Anthropic)
    expect(json.object).toBe("chat.completion");
    expect(json.choices[0].message.content).toBe("Hello from Anthropic!");
    expect(json.choices[0].finish_reason).toBe("stop");
    // Usage should be mapped
    expect(json.usage.prompt_tokens).toBe(10);
    expect(json.usage.completion_tokens).toBe(5);
    // Two fetch calls: OpenAI (failed) then Anthropic (succeeded)
    expect(mock.calls).toHaveLength(2);
  });
});

describe("fallback: primary 429, falls back", () => {
  it("retries on rate limit", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_ERROR_429, 429) },
      { match: (u) => u.includes("anthropic.com"), respond: () => jsonResponse(ANTHROPIC_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(makeRequest());

    expect(res.status).toBe(200);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("fallback: primary 400, no fallback", () => {
  it("returns the 400 as-is without trying fallback", async () => {
    const mock = installMockFetch([
      {
        match: (u) => u.includes("openai.com"),
        respond: () => jsonResponse({ error: { message: "Bad request" } }, 400),
      },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(makeRequest());

    expect(res.status).toBe(400);
    // Only one call — 400 is not retriable
    expect(mock.calls).toHaveLength(1);
  });
});

describe("fallback: tool call cross-provider", () => {
  it("translates Anthropic tool_use to OpenAI tool_calls", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_ERROR_500, 500) },
      { match: (u) => u.includes("anthropic.com"), respond: () => jsonResponse(ANTHROPIC_TOOL_USE_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(
      makeRequest({
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get weather",
              parameters: { type: "object", properties: { location: { type: "string" } } },
            },
          },
        ],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    const toolCalls = json.choices[0].message.tool_calls;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe("get_weather");
    expect(JSON.parse(toolCalls[0].function.arguments)).toEqual({ location: "San Francisco" });
  });

  it("sends translated tools to Anthropic in correct format", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_ERROR_500, 500) },
      { match: (u) => u.includes("anthropic.com"), respond: () => jsonResponse(ANTHROPIC_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    await app.request(
      makeRequest({
        tools: [
          {
            type: "function",
            function: { name: "f", description: "d", parameters: { type: "object" } },
          },
        ],
      }),
    );

    // Check what was sent to Anthropic
    const anthropicCall = mock.calls.find((c) => c.url.includes("anthropic.com"));
    expect(anthropicCall).toBeTruthy();
    const sentBody = JSON.parse(anthropicCall!.body!);
    expect(sentBody.tools[0].name).toBe("f");
    expect(sentBody.tools[0].input_schema).toEqual({ type: "object" });
    expect(sentBody.model).toBe("claude-sonnet-4-5-20250929");
  });
});

describe("fallback: all keys exhausted", () => {
  it("returns last error when all keys fail", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_ERROR_500, 500) },
      { match: (u) => u.includes("anthropic.com"), respond: () => jsonResponse(ANTHROPIC_ERROR_500, 500) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(makeRequest());

    expect(res.status).toBe(500);
    expect(mock.calls).toHaveLength(2);
  });
});

describe("fallback: error response not translated", () => {
  it("returns raw Anthropic error for non-retriable failures", async () => {
    const mock = installMockFetch([
      { match: (u) => u.includes("openai.com"), respond: () => jsonResponse(OPENAI_ERROR_500, 500) },
      { match: (u) => u.includes("anthropic.com"), respond: () => jsonResponse(ANTHROPIC_ERROR_400, 400) },
    ]);
    mockRestore = mock.restore;

    const app = makeApp();
    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(400);
    // Should be the raw Anthropic error, NOT translated through anthropicResponseToOpenai
    expect(json.type).toBe("error");
    expect(json.error.type).toBe("invalid_request_error");
  });
});
