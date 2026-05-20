import { describe, it, expect } from "bun:test";
import { executeBlockRequest } from "../src/actions/block-request";
import { executeFindReplace } from "../src/actions/find-replace";
import { executeRedactField } from "../src/actions/redact-field";
import { executeLogOnly } from "../src/actions/log-only";
import type { TokenVault } from "../src/providers/types";
import type {
  RequestContext,
  AuthInfo,
  BlockRequestAction,
  FindReplaceAction,
  RedactFieldAction,
  LogOnlyAction,
} from "../src/types";

function makeVault(): TokenVault & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(_teamId: string, token: string, value: string, _ttl: number) {
      store.set(token, value);
    },
    async get(_teamId: string, token: string) {
      return store.get(token) ?? null;
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCtx(body: Record<string, unknown>): RequestContext {
  const auth: AuthInfo = {
    team_id: "team-123",
    user_id: "user-456",
    fallback_mode: "passthrough",
    zero_data_mode: false,
    tier: "pro",
  };
  return {
    requestId: "req-1",
    auth,
    method: "POST",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    headers: {},
    body: JSON.stringify(body),
    parsedBody: structuredClone(body),
    startedAt: Date.now(),
    traceId: null,
    label: null,
    metadata: null,
    seq: null,
    sessionId: null,
  };
}

function makeBlockAction(overrides: Partial<BlockRequestAction> = {}): BlockRequestAction {
  return {
    id: "action-block",
    enabled: true,
    type: "block_request",
    status_code: 403,
    message: "Blocked",
    ...overrides,
  };
}

function makeFindReplaceAction(overrides: Partial<FindReplaceAction> = {}): FindReplaceAction {
  return {
    id: "action-find",
    enabled: true,
    type: "find_replace",
    find: "foo",
    replace: "bar",
    is_regex: false,
    case_sensitive: true,
    ...overrides,
  };
}

function makeRedactAction(overrides: Partial<RedactFieldAction> = {}): RedactFieldAction {
  return {
    id: "action-redact",
    enabled: true,
    type: "redact_field",
    fields: ["email"],
    replacement: "[REDACTED]",
    ...overrides,
  };
}

function makeLogAction(overrides: Partial<LogOnlyAction> = {}): LogOnlyAction {
  return {
    id: "action-log",
    enabled: true,
    type: "log_only",
    severity: "info",
    label: "my-tag",
    ...overrides,
  };
}

// ─── executeBlockRequest ──────────────────────────────────────────────────────

describe("executeBlockRequest", () => {
  it("returns blocked:true with statusCode and message", () => {
    const result = executeBlockRequest(makeBlockAction({ status_code: 403, message: "Forbidden" }));
    expect(result.blocked).toBe(true);
    expect(result.statusCode).toBe(403);
    expect(result.message).toBe("Forbidden");
  });

  it("supports custom status code 451", () => {
    const result = executeBlockRequest(makeBlockAction({ status_code: 451, message: "Unavailable for legal reasons" }));
    expect(result.blocked).toBe(true);
    expect(result.statusCode).toBe(451);
    expect(result.message).toBe("Unavailable for legal reasons");
  });
});

// ─── executeFindReplace ───────────────────────────────────────────────────────

describe("executeFindReplace", () => {
  it("literal string replacement: body mutated and parsedBody re-parsed", async () => {
    const ctx = makeCtx({ text: "hello foo world" });
    await executeFindReplace(ctx, makeFindReplaceAction({ find: "foo", replace: "bar" }), makeVault());
    expect(ctx.body).toContain("bar");
    expect(ctx.body).not.toContain("foo");
    const parsed = ctx.parsedBody as Record<string, unknown>;
    expect(parsed.text).toBe("hello bar world");
  });

  it("regex replacement with \\d+ pattern", async () => {
    const ctx = makeCtx({ text: "order 123 and order 456" });
    await executeFindReplace(ctx, makeFindReplaceAction({ find: "\\d+", replace: "NUM", is_regex: true, case_sensitive: true }), makeVault());
    const parsed = ctx.parsedBody as Record<string, unknown>;
    expect(parsed.text).toBe("order NUM and order NUM");
  });

  it("case-insensitive mode replaces all occurrences regardless of case", async () => {
    const ctx = makeCtx({ text: "Foo foo FOO" });
    await executeFindReplace(ctx, makeFindReplaceAction({ find: "foo", replace: "bar", case_sensitive: false }), makeVault());
    const parsed = ctx.parsedBody as Record<string, unknown>;
    expect(parsed.text).toBe("bar bar bar");
  });

  it("invalid regex: body unchanged, returns {}", async () => {
    const ctx = makeCtx({ text: "original" });
    const originalBody = ctx.body;
    const result = await executeFindReplace(ctx, makeFindReplaceAction({ find: "[invalid(", replace: "x", is_regex: true }), makeVault());
    expect(ctx.body).toBe(originalBody);
    expect(result).toEqual({});
  });

  it("broken JSON after replacement: parsedBody stays stale from before action", async () => {
    const ctx = makeCtx({ dummy: "placeholder" });
    ctx.body = '{"key":"val"}SUFFIX';
    ctx.parsedBody = { key: "val" };

    await executeFindReplace(ctx, makeFindReplaceAction({ find: "val", replace: "v" }), makeVault());

    expect(ctx.body).toContain('"v"');

    const ctx2 = makeCtx({ dummy: true });
    ctx2.body = "not json at all, find me";
    ctx2.parsedBody = { stale: true };
    await executeFindReplace(ctx2, makeFindReplaceAction({ find: "find me", replace: "replaced" }), makeVault());
    expect(ctx2.body).toBe("not json at all, replaced");
    expect((ctx2.parsedBody as Record<string, unknown>).stale).toBe(true);
  });

  it("mask_and_restore: regex matches replaced with prefixed UUID tokens and stored in vault", async () => {
    const ctx = makeCtx({ text: "my NI is AB123456C and second AB654321D" });
    const vault = makeVault();
    await executeFindReplace(
      ctx,
      makeFindReplaceAction({
        find: "\\b[A-Z]{2}\\d{6}[A-Z]\\b",
        replace: "",
        is_regex: true,
        case_sensitive: true,
        mode: "mask_and_restore",
        token_prefix: "nin_",
        ttl_seconds: 300,
      }),
      vault,
    );
    expect(ctx.body).not.toContain("AB123456C");
    expect(ctx.body).not.toContain("AB654321D");
    expect(ctx.body).toMatch(/nin_[0-9a-f-]{36}/);
    const stored = [...vault.store.values()];
    expect(stored).toContain("AB123456C");
    expect(stored).toContain("AB654321D");
  });

  it("mask_and_restore: right-to-left replacement preserves match boundaries", async () => {
    const ctx = makeCtx({ text: "abc-111-def-222-ghi-333" });
    const vault = makeVault();
    await executeFindReplace(
      ctx,
      makeFindReplaceAction({
        find: "\\d{3}",
        replace: "",
        is_regex: true,
        case_sensitive: true,
        mode: "mask_and_restore",
        token_prefix: "n_",
        ttl_seconds: 60,
      }),
      vault,
    );
    expect(vault.store.size).toBe(3);
    const stored = [...vault.store.values()].sort();
    expect(stored).toEqual(["111", "222", "333"]);
  });

  it("mask_and_restore on free tier falls back to one-way redaction and does not write to vault", async () => {
    const ctx = makeCtx({ text: "leaked AB123456C" });
    ctx.auth = { ...ctx.auth, tier: "free" };
    const vault = makeVault();
    await executeFindReplace(
      ctx,
      makeFindReplaceAction({
        find: "\\b[A-Z]{2}\\d{6}[A-Z]\\b",
        replace: "[NI]",
        is_regex: true,
        case_sensitive: true,
        mode: "mask_and_restore",
        token_prefix: "nin_",
        ttl_seconds: 300,
      }),
      vault,
    );
    expect(ctx.body).toContain("[NI]");
    expect(ctx.body).not.toContain("nin_");
    expect(vault.store.size).toBe(0);
  });

  it("mode absent: behaves as one-way (backwards compat)", async () => {
    const ctx = makeCtx({ text: "hello foo" });
    const vault = makeVault();
    await executeFindReplace(ctx, makeFindReplaceAction({ find: "foo", replace: "bar" }), vault);
    expect((ctx.parsedBody as Record<string, unknown>).text).toBe("hello bar");
    expect(vault.store.size).toBe(0);
  });
});

// ─── executeRedactField ───────────────────────────────────────────────────────

describe("executeRedactField", () => {
  it("top-level field replaced", () => {
    const ctx = makeCtx({ email: "secret@example.com", name: "Alice" });
    executeRedactField(ctx, makeRedactAction({ fields: ["email"], replacement: "[REDACTED]" }));
    const parsed = ctx.parsedBody as Record<string, unknown>;
    expect(parsed.email).toBe("[REDACTED]");
    expect(parsed.name).toBe("Alice");
  });

  it("nested path user.email", () => {
    const ctx = makeCtx({ user: { email: "secret@example.com", role: "admin" } });
    executeRedactField(ctx, makeRedactAction({ fields: ["user.email"], replacement: "[REDACTED]" }));
    const parsed = ctx.parsedBody as Record<string, unknown>;
    const user = parsed.user as Record<string, unknown>;
    expect(user.email).toBe("[REDACTED]");
    expect(user.role).toBe("admin");
  });

  it("array index items[1]", () => {
    const ctx = makeCtx({ items: ["keep", "remove", "keep2"] });
    executeRedactField(ctx, makeRedactAction({ fields: ["items[1]"], replacement: "[REDACTED]" }));
    const parsed = ctx.parsedBody as Record<string, unknown>;
    const items = parsed.items as string[];
    expect(items[0]).toBe("keep");
    expect(items[1]).toBe("[REDACTED]");
    expect(items[2]).toBe("keep2");
  });

  it("missing field is a no-op: body unchanged", () => {
    const ctx = makeCtx({ name: "Alice" });
    const originalBody = ctx.body;
    executeRedactField(ctx, makeRedactAction({ fields: ["email"], replacement: "[REDACTED]" }));
    expect(ctx.body).toBe(originalBody);
  });

  it("null as replacement value", () => {
    const ctx = makeCtx({ secret: "sensitive" });
    executeRedactField(ctx, makeRedactAction({ fields: ["secret"], replacement: "null" }));
    const parsed = ctx.parsedBody as Record<string, unknown>;
    // replacement is string "null" per RedactFieldAction type
    expect(parsed.secret).toBe("null");
  });

  it("body is re-serialized after redaction", () => {
    const ctx = makeCtx({ email: "secret@example.com" });
    executeRedactField(ctx, makeRedactAction({ fields: ["email"], replacement: "[REDACTED]" }));
    const reparsed = JSON.parse(ctx.body) as Record<string, unknown>;
    expect(reparsed.email).toBe("[REDACTED]");
  });

  it("parsedBody not an object: returns {} and leaves context unchanged", () => {
    const ctx = makeCtx({ dummy: true });
    ctx.parsedBody = null;
    const originalBody = ctx.body;
    const result = executeRedactField(ctx, makeRedactAction());
    expect(result).toEqual({});
    expect(ctx.body).toBe(originalBody);
  });
});

// ─── executeLogOnly ───────────────────────────────────────────────────────────

describe("executeLogOnly", () => {
  it("returns tags with severity and label", () => {
    const result = executeLogOnly(makeLogAction({ severity: "info", label: "my-tag" }));
    expect(result.tags).toEqual([{ severity: "info", label: "my-tag" }]);
  });

  it("warn severity", () => {
    const result = executeLogOnly(makeLogAction({ severity: "warn", label: "warn-tag" }));
    expect(result.tags).toEqual([{ severity: "warn", label: "warn-tag" }]);
  });

  it("critical severity", () => {
    const result = executeLogOnly(makeLogAction({ severity: "critical", label: "critical-tag" }));
    expect(result.tags).toEqual([{ severity: "critical", label: "critical-tag" }]);
  });

  it("blocked is undefined", () => {
    const result = executeLogOnly(makeLogAction());
    expect(result.blocked).toBeUndefined();
  });
});
