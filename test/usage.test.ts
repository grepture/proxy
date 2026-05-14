import { describe, it, expect } from "bun:test";
import { extractUsage } from "../src/proxy/usage";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

describe("extractUsage — OpenAI Chat Completions (buffered)", () => {
  it("reads prompt_tokens / completion_tokens", () => {
    const body = JSON.stringify({
      model: "gpt-4o-mini",
      usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
    });
    const usage = extractUsage(body, OPENAI_URL);
    expect(usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      model: "gpt-4o-mini",
      provider: "openai",
    });
  });
});

describe("extractUsage — OpenAI Responses API (buffered)", () => {
  it("reads input_tokens / output_tokens at top level", () => {
    const body = JSON.stringify({
      id: "resp_abc",
      model: "gpt-5",
      usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
    });
    const usage = extractUsage(body, OPENAI_RESPONSES_URL);
    expect(usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 50,
      total_tokens: 150,
      model: "gpt-5",
      provider: "openai",
    });
  });

  it("falls back to summed total when total_tokens missing", () => {
    const body = JSON.stringify({
      model: "gpt-5",
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const usage = extractUsage(body, OPENAI_RESPONSES_URL);
    expect(usage?.total_tokens).toBe(10);
  });
});

describe("extractUsage — OpenAI Responses API (streaming SSE)", () => {
  it("reads usage from the nested response.completed event", () => {
    const sse = [
      "event: response.created",
      'data: {"type":"response.created","response":{"id":"resp_x","model":"gpt-5"}}',
      "",
      "event: response.output_text.delta",
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      "",
      "event: response.completed",
      'data: {"type":"response.completed","response":{"id":"resp_x","model":"gpt-5","usage":{"input_tokens":42,"output_tokens":8,"total_tokens":50}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");

    const usage = extractUsage(sse, OPENAI_RESPONSES_URL);
    expect(usage).toEqual({
      prompt_tokens: 42,
      completion_tokens: 8,
      total_tokens: 50,
      model: "gpt-5",
      provider: "openai",
    });
  });
});

describe("extractUsage — returns null on missing usage", () => {
  it("returns null when neither shape is present", () => {
    const body = JSON.stringify({ model: "gpt-5", output: [{ type: "message" }] });
    expect(extractUsage(body, OPENAI_RESPONSES_URL)).toBeNull();
  });
});
