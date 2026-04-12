import { describe, it, expect } from "bun:test";
import { getByPath, setByPath, executeTokenize, detokenize } from "../src/actions/tokenize";
import type { TokenVault } from "../src/providers/types";
import type { RequestContext, TokenizeAction, AuthInfo } from "../src/types";

// ─── Helpers ────────────────────────────────────────────────────────────────

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
    parsedBody: body,
    startedAt: Date.now(),
    traceId: null,
    label: null,
    metadata: null,
    seq: null,
    sessionId: null,
  };
}

function makeAction(fields: string[], prefix = "tok_"): TokenizeAction {
  return {
    id: "action-1",
    enabled: true,
    type: "tokenize",
    fields,
    token_prefix: prefix,
    ttl_seconds: 300,
  };
}

// ─── getByPath ───────────────────────────────────────────────────────────────

describe("getByPath", () => {
  it("simple key", () => {
    expect(getByPath({ name: "Alice" }, "name")).toBe("Alice");
  });

  it("nested dot path", () => {
    expect(getByPath({ user: { email: "a@b.com" } }, "user.email")).toBe("a@b.com");
  });

  it("bracket notation", () => {
    expect(getByPath({ items: ["first", "second"] }, "items[0]")).toBe("first");
  });

  it("mixed path: data[0].users[0].email", () => {
    const obj = { data: [{ users: [{ email: "x@y.com" }] }] };
    expect(getByPath(obj, "data[0].users[0].email")).toBe("x@y.com");
  });

  it("strips $. prefix", () => {
    expect(getByPath({ foo: "bar" }, "$.foo")).toBe("bar");
  });

  it("missing intermediate → undefined", () => {
    expect(getByPath({ a: {} }, "a.b.c")).toBeUndefined();
  });

  it("null intermediate → undefined", () => {
    expect(getByPath({ a: null }, "a.b")).toBeUndefined();
  });

  it("primitive intermediate → undefined", () => {
    expect(getByPath({ a: 42 }, "a.b")).toBeUndefined();
  });
});

// ─── setByPath ───────────────────────────────────────────────────────────────

describe("setByPath", () => {
  it("simple key", () => {
    const obj = { name: "Alice" };
    setByPath(obj, "name", "Bob");
    expect(obj.name).toBe("Bob");
  });

  it("nested dot path", () => {
    const obj = { user: { email: "old@example.com" } };
    setByPath(obj, "user.email", "new@example.com");
    expect((obj.user as Record<string, unknown>).email).toBe("new@example.com");
  });

  it("bracket notation", () => {
    const obj = { items: ["a", "b"] };
    setByPath(obj, "items[1]", "z");
    expect(obj.items[1]).toBe("z");
  });

  it("missing parent chain → no-op", () => {
    const obj: Record<string, unknown> = {};
    // Should not throw; obj stays unchanged
    setByPath(obj, "a.b.c", "value");
    expect(obj.a).toBeUndefined();
  });

  it("null intermediate → no-op", () => {
    const obj = { a: null };
    setByPath(obj, "a.b", "value");
    expect(obj.a).toBeNull();
  });
});

// ─── executeTokenize ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("executeTokenize", () => {
  it("tokenizes a single field: vault stores original, body has prefix+uuid", async () => {
    const vault = makeVault();
    const ctx = makeCtx({ email: "secret@example.com" });
    const action = makeAction(["email"], "tok_");

    await executeTokenize(ctx, action, vault);

    const parsed = JSON.parse(ctx.body) as Record<string, unknown>;
    const token = parsed.email as string;

    expect(token.startsWith("tok_")).toBe(true);
    const uuid = token.slice("tok_".length);
    expect(UUID_RE.test(uuid)).toBe(true);

    // Vault stored the original value
    expect(vault.store.size).toBe(1);
    const stored = vault.store.get(token);
    expect(stored).toBe("secret@example.com");
  });

  it("tokenizes multiple fields", async () => {
    const vault = makeVault();
    const ctx = makeCtx({ email: "a@b.com", ssn: "123-45-6789" });
    const action = makeAction(["email", "ssn"], "tok_");

    await executeTokenize(ctx, action, vault);

    const parsed = JSON.parse(ctx.body) as Record<string, string>;
    expect(parsed.email.startsWith("tok_")).toBe(true);
    expect(parsed.ssn.startsWith("tok_")).toBe(true);
    expect(parsed.email).not.toBe(parsed.ssn);
    expect(vault.store.size).toBe(2);
    expect(vault.store.get(parsed.email)).toBe("a@b.com");
    expect(vault.store.get(parsed.ssn)).toBe("123-45-6789");
  });

  it("JSON.stringifies non-string values", async () => {
    const vault = makeVault();
    const ctx = makeCtx({ count: 42 });
    const action = makeAction(["count"], "tok_");

    await executeTokenize(ctx, action, vault);

    const parsed = JSON.parse(ctx.body) as Record<string, unknown>;
    const token = parsed.count as string;
    expect(vault.store.get(token)).toBe("42");
  });

  it("silently skips missing fields", async () => {
    const vault = makeVault();
    const ctx = makeCtx({ name: "Alice" });
    const action = makeAction(["email"], "tok_");

    await executeTokenize(ctx, action, vault);

    const parsed = JSON.parse(ctx.body) as Record<string, unknown>;
    expect(vault.store.size).toBe(0);
    // name untouched, email not present
    expect(parsed.name).toBe("Alice");
    expect(parsed.email).toBeUndefined();
  });

  it("silently skips null fields", async () => {
    const vault = makeVault();
    const ctx = makeCtx({ email: null });
    const action = makeAction(["email"], "tok_");

    await executeTokenize(ctx, action, vault);

    const parsed = JSON.parse(ctx.body) as Record<string, unknown>;
    expect(vault.store.size).toBe(0);
    expect(parsed.email).toBeNull();
  });
});

// ─── detokenize ───────────────────────────────────────────────────────────────

describe("detokenize", () => {
  const TEAM = "team-123";

  async function seedVault(vault: ReturnType<typeof makeVault>, entries: Record<string, string>) {
    for (const [token, value] of Object.entries(entries)) {
      vault.store.set(token, value);
    }
  }

  it("restores a token found in vault", async () => {
    const vault = makeVault();
    const token = "tok_" + "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    await seedVault(vault, { [token]: "secret@example.com" });

    const result = await detokenize(`The email is ${token} here.`, TEAM, ["tok_"], vault);
    expect(result).toBe("The email is secret@example.com here.");
  });

  it("replaces expired/missing token with [TOKEN_EXPIRED]", async () => {
    const vault = makeVault();
    const token = "tok_" + "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    // Nothing stored in vault

    const result = await detokenize(`Value: ${token}`, TEAM, ["tok_"], vault);
    expect(result).toBe("Value: [TOKEN_EXPIRED]");
  });

  it("replaces multiple different tokens", async () => {
    const vault = makeVault();
    const t1 = "tok_" + "11111111-1111-1111-1111-111111111111";
    const t2 = "tok_" + "22222222-2222-2222-2222-222222222222";
    await seedVault(vault, { [t1]: "Alice", [t2]: "Bob" });

    const result = await detokenize(`${t1} and ${t2}`, TEAM, ["tok_"], vault);
    expect(result).toBe("Alice and Bob");
  });

  it("replaces the same token appearing twice", async () => {
    const vault = makeVault();
    const token = "tok_" + "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await seedVault(vault, { [token]: "secret" });

    const result = await detokenize(`${token} and ${token}`, TEAM, ["tok_"], vault);
    expect(result).toBe("secret and secret");
  });

  it("returns text unchanged when no tokens present", async () => {
    const vault = makeVault();
    const text = "Hello, world! No tokens here.";
    const result = await detokenize(text, TEAM, ["tok_"], vault);
    expect(result).toBe(text);
  });

  it("returns text unchanged when tokenPrefixes is empty", async () => {
    const vault = makeVault();
    const token = "tok_" + "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await seedVault(vault, { [token]: "secret" });
    const text = `Value: ${token}`;

    const result = await detokenize(text, TEAM, [], vault);
    expect(result).toBe(text);
  });

  it("handles regex special characters in prefix (e.g. 'pii.test_')", async () => {
    const vault = makeVault();
    const prefix = "pii.test_";
    const token = prefix + "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    await seedVault(vault, { [token]: "sensitive" });

    const result = await detokenize(`data=${token}`, TEAM, [prefix], vault);
    expect(result).toBe("data=sensitive");
  });
});
