/**
 * Live end-to-end tests against real OpenAI and Anthropic APIs.
 *
 * These tests verify that actual provider response formats work through the
 * cross-provider fallback pipeline. They catch format changes that mocked
 * tests can't detect.
 *
 * Skipped when API keys are not set:
 *   OPENAI_API_KEY=sk-... ANTHROPIC_API_KEY=sk-ant-... bun test
 */
import { describe, it, expect, afterAll, beforeAll } from "bun:test";
import type { ResolvedProviderKey } from "../src/providers/types";
import { createTestProviders } from "./helpers/test-providers";
import { createTestApp, resetProviders } from "./helpers/create-test-app";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const hasKeys = !!ANTHROPIC_API_KEY;

// Use describe.skip when keys aren't available
const suite = hasKeys ? describe : describe.skip;

suite("live: cross-provider fallback (OpenAI → Anthropic)", () => {
  let app: ReturnType<typeof createTestApp>;

  // Key chain: broken OpenAI key → real Anthropic key
  const keys: ResolvedProviderKey[] = [
    {
      id: "live-openai",
      provider: "openai",
      decrypted: "sk-invalid-will-always-fail",
      default_model: null,
      fallback_key_id: "live-anthropic",
    },
    {
      id: "live-anthropic",
      provider: "anthropic",
      decrypted: ANTHROPIC_API_KEY!,
      default_model: "claude-sonnet-4-5-20250929",
      fallback_key_id: null,
    },
  ];

  beforeAll(() => {
    app = createTestApp(createTestProviders(keys));
  });

  afterAll(() => {
    resetProviders();
  });

  function makeRequest(body: Record<string, unknown> = {}) {
    return new Request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-key",
        "X-Grepture-Target": "https://api.openai.com/v1/chat/completions",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{ role: "user", content: "Reply with exactly: pong" }],
        ...body,
      }),
    });
  }

  it("text request falls back to Anthropic and returns OpenAI-formatted response", async () => {
    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    // Should be in OpenAI format (translated from real Anthropic response)
    expect(json.object).toBe("chat.completion");
    expect(json.id).toMatch(/^chatcmpl-/);
    expect(json.choices).toHaveLength(1);
    expect(json.choices[0].message.role).toBe("assistant");
    expect(typeof json.choices[0].message.content).toBe("string");
    expect(json.choices[0].message.content.length).toBeGreaterThan(0);
    expect(json.choices[0].finish_reason).toBe("stop");
  }, 30_000);

  it("response has non-zero usage tokens", async () => {
    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.usage).toBeDefined();
    expect(json.usage.prompt_tokens).toBeGreaterThan(0);
    expect(json.usage.completion_tokens).toBeGreaterThan(0);
    expect(json.usage.total_tokens).toBe(
      json.usage.prompt_tokens + json.usage.completion_tokens,
    );
  }, 30_000);

  it("response has model field populated", async () => {
    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(typeof json.model).toBe("string");
    expect(json.model.length).toBeGreaterThan(0);
  }, 30_000);

  it("tool call request falls back and translates tool_use to tool_calls", async () => {
    const res = await app.request(
      makeRequest({
        messages: [
          { role: "user", content: "What is the weather in San Francisco? Use the get_weather tool." },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "get_weather",
              description: "Get current weather for a location",
              parameters: {
                type: "object",
                properties: {
                  location: { type: "string", description: "City name" },
                },
                required: ["location"],
              },
            },
          },
        ],
      }),
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.object).toBe("chat.completion");
    // Model should use the tool
    expect(json.choices[0].finish_reason).toBe("tool_calls");
    expect(json.choices[0].message.tool_calls).toBeDefined();
    expect(json.choices[0].message.tool_calls.length).toBeGreaterThan(0);

    const tc = json.choices[0].message.tool_calls[0];
    expect(tc.type).toBe("function");
    expect(tc.function.name).toBe("get_weather");
    expect(typeof tc.function.arguments).toBe("string");
    // Arguments should be valid JSON
    const args = JSON.parse(tc.function.arguments);
    expect(args.location).toBeDefined();
  }, 30_000);
});
