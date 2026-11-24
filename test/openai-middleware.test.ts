import { describe, expect, test } from "bun:test";
import { normalizeMaxTokens } from "../src/proxy/openai-middleware";

describe("normalizeMaxTokens", () => {
  test("renames max_tokens to max_completion_tokens", () => {
    const body: Record<string, unknown> = { model: "gpt-5.4-mini", max_tokens: 512 };
    expect(normalizeMaxTokens(body)).toBe(true);
    expect(body).toEqual({ model: "gpt-5.4-mini", max_completion_tokens: 512 });
  });

  test("keeps an explicit max_completion_tokens and drops max_tokens", () => {
    const body: Record<string, unknown> = { max_tokens: 100, max_completion_tokens: 200 };
    expect(normalizeMaxTokens(body)).toBe(true);
    expect(body).toEqual({ max_completion_tokens: 200 });
  });

  test("leaves bodies without max_tokens untouched", () => {
    const body: Record<string, unknown> = { model: "gpt-4o", max_completion_tokens: 50 };
    expect(normalizeMaxTokens(body)).toBe(false);
    expect(body).toEqual({ model: "gpt-4o", max_completion_tokens: 50 });
  });
});
