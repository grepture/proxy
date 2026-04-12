import { describe, it, expect } from "bun:test";
import { executeRedactPii } from "../src/actions/redact-pii";
import type { RedactPiiAction, RequestContext, AuthInfo } from "../src/types";
import type { TokenVault } from "../src/providers/types";
import { JSON_BODY_WITH_PII } from "./fixtures/pii-texts";

function makeCtx(body: string): RequestContext {
  return {
    requestId: "test-req",
    auth: { team_id: "test-team", user_id: "test-user", tier: "free", fallback_mode: "error", zero_data_mode: false } as AuthInfo,
    method: "POST",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    headers: {},
    body,
    parsedBody: JSON.parse(body),
    startedAt: Date.now(),
    traceId: null, label: null, metadata: null, seq: null, sessionId: null,
  };
}

function makeVault(): TokenVault & { stored: Map<string, { value: string; ttl: number }> } {
  const stored = new Map<string, { value: string; ttl: number }>();
  return {
    stored,
    async set(_teamId: string, token: string, value: string, ttl: number) {
      stored.set(token, { value, ttl });
    },
    async get(_teamId: string, token: string) {
      return stored.get(token)?.value ?? null;
    },
  };
}

const BASE_ACTION: RedactPiiAction = {
  id: "action-1", enabled: true, type: "redact_pii",
  categories: ["email", "phone"],
  replacement: "placeholder", mode: "redact",
  token_prefix: "pii_", ttl_seconds: 3600,
};

describe("executeRedactPii", () => {
  it("mask_and_restore: stores originals in vault, replaces body with tokens", async () => {
    const ctx = makeCtx(JSON_BODY_WITH_PII);
    const vault = makeVault();
    const action: RedactPiiAction = { ...BASE_ACTION, mode: "mask_and_restore" };
    await executeRedactPii(ctx, action, vault);
    expect(ctx.body).not.toContain("alice@example.com");
    expect(ctx.body).not.toContain("555-987-6543");
    expect(ctx.body).toContain("pii_");
    expect(vault.stored.size).toBeGreaterThanOrEqual(1);
    const values = [...vault.stored.values()].map((v) => v.value);
    expect(values).toContain("alice@example.com");
  });

  it("mask_and_restore: vault entries have correct TTL", async () => {
    const ctx = makeCtx(JSON_BODY_WITH_PII);
    const vault = makeVault();
    const action: RedactPiiAction = { ...BASE_ACTION, mode: "mask_and_restore", ttl_seconds: 7200 };
    await executeRedactPii(ctx, action, vault);
    for (const entry of vault.stored.values()) {
      expect(entry.ttl).toBe(7200);
    }
  });

  it("permanent redaction: replaces PII with placeholders, no vault writes", async () => {
    const ctx = makeCtx(JSON_BODY_WITH_PII);
    const vault = makeVault();
    await executeRedactPii(ctx, { ...BASE_ACTION, mode: "redact", replacement: "placeholder" }, vault);
    expect(ctx.body).toContain("[EMAIL_REDACTED]");
    expect(ctx.body).not.toContain("alice@example.com");
    expect(vault.stored.size).toBe(0);
  });

  it("no PII found: body unchanged", async () => {
    const body = JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "Hello" }] });
    const ctx = makeCtx(body);
    const vault = makeVault();
    await executeRedactPii(ctx, BASE_ACTION, vault);
    expect(ctx.body).toBe(body);
    expect(vault.stored.size).toBe(0);
  });

  it("parsedBody is valid JSON after replacement", async () => {
    const ctx = makeCtx(JSON_BODY_WITH_PII);
    const vault = makeVault();
    await executeRedactPii(ctx, { ...BASE_ACTION, mode: "mask_and_restore" }, vault);
    expect(ctx.parsedBody).not.toBeNull();
    expect(() => JSON.stringify(ctx.parsedBody)).not.toThrow();
  });
});
