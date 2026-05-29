import { describe, it, expect } from "bun:test";
import { executeRedactPii } from "../src/actions/redact-pii";
import type { RedactPiiAction, RequestContext, AuthInfo } from "../src/types";
import type { TokenVault } from "../src/providers/types";

function makeCtx(body: string): RequestContext {
  return {
    requestId: "r", auth: { team_id: "t", user_id: "u", tier: "free", fallback_mode: "error", zero_data_mode: false } as AuthInfo,
    method: "POST", targetUrl: "https://api.openai.com/v1/chat/completions",
    headers: {}, body, parsedBody: (() => { try { return JSON.parse(body); } catch { return null; } })(),
    startedAt: Date.now(), traceId: null, label: null, metadata: null, seq: null, sessionId: null,
  };
}

const noopVault: TokenVault = { async set() {}, async get() { return null; } };

const PHONE_REDACT: RedactPiiAction = {
  id: "a1", enabled: true, type: "redact_pii",
  categories: ["phone"], replacement: "placeholder", mode: "redact",
  token_prefix: "", ttl_seconds: 0,
};

describe("executeRedactPii — JSON structural safety", () => {
  it("does not corrupt JSON when a numeric field resembles a phone number", async () => {
    // A real OpenAI chat completion: `created` is a 10-digit unix timestamp
    // (number), content carries a genuine phone number (string).
    const body = JSON.stringify({
      id: "chatcmpl-abc123",
      object: "chat.completion",
      created: 1716988800,
      model: "gpt-4o",
      choices: [{ index: 0, message: { role: "assistant", content: "Call us at 555-123-4567 for help." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    });
    const ctx = makeCtx(body);

    await executeRedactPii(ctx, PHONE_REDACT, noopVault);

    // The whole point: the result must still be valid JSON.
    expect(() => JSON.parse(ctx.body)).not.toThrow();

    const out = JSON.parse(ctx.body);
    // The numeric timestamp is untouched (numbers aren't PII candidates).
    expect(out.created).toBe(1716988800);
    // The genuine phone inside the string IS still redacted.
    expect(out.choices[0].message.content).toContain("[PHONE_REDACTED]");
    expect(out.choices[0].message.content).not.toContain("555-123-4567");
  });

  it("still redacts PII in non-JSON bodies (fallback path)", async () => {
    const ctx = makeCtx("plain text, call 555-123-4567 now");
    await executeRedactPii(ctx, PHONE_REDACT, noopVault);
    expect(ctx.body).toContain("[PHONE_REDACTED]");
    expect(ctx.body).not.toContain("555-123-4567");
  });
});
