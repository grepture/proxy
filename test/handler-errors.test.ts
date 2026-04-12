import { describe, it, expect, afterEach } from "bun:test";
import { createTestProviders } from "./helpers/test-providers";
import { createTestApp, resetProviders } from "./helpers/create-test-app";
import { installMockFetch } from "./helpers/mock-fetch";
import { jsonResponse, OPENAI_TEXT_RESPONSE } from "./helpers/mock-responses";

let mockRestore: (() => void) | null = null;

afterEach(() => {
  mockRestore?.();
  mockRestore = null;
  resetProviders();
});

function makeRequest(overrides: {
  authorization?: string | null;
  target?: string | null;
  authForward?: string | null;
  body?: Record<string, unknown>;
} = {}) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Authorization: include by default, omit if explicitly null
  if (overrides.authorization !== null) {
    headers["Authorization"] = overrides.authorization ?? "Bearer test-key";
  }

  // X-Grepture-Target: include by default, omit if explicitly null
  if (overrides.target !== null) {
    headers["X-Grepture-Target"] = overrides.target ?? "https://api.openai.com/v1/chat/completions";
  }

  // X-Grepture-Auth-Forward: include by default so handler skips provider key
  // resolution (no keys configured in default test providers). Omit if explicitly null.
  if (overrides.authForward !== null) {
    headers["X-Grepture-Auth-Forward"] = overrides.authForward ?? "Bearer sk-test-forward";
  }

  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(overrides.body ?? {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hello" }],
    }),
  });
}

// ─── Auth errors ──────────────────────────────────────────────────────────

describe("handler errors: auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const providers = createTestProviders();
    const app = createTestApp(providers);

    const res = await app.request(makeRequest({ authorization: null }));
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toContain("Missing Authorization");
  });

  it("returns 401 when API key is invalid (authenticate returns null)", async () => {
    const providers = createTestProviders();
    providers.auth = {
      authenticate: async () => null,
    };
    const app = createTestApp(providers);

    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(401);
    expect(json.error).toContain("Invalid API key");
  });

  it("returns 500 when auth service throws", async () => {
    const providers = createTestProviders();
    providers.auth = {
      authenticate: async () => {
        throw new Error("Auth service unavailable");
      },
    };
    const app = createTestApp(providers);

    const origError = console.error;
    console.error = () => {};
    const res = await app.request(makeRequest());
    console.error = origError;
    const json = await res.json();

    expect(res.status).toBe(500);
    expect(json.error).toContain("Authentication service error");
  });
});

// ─── Target URL errors ────────────────────────────────────────────────────

describe("handler errors: target URL", () => {
  it("returns 400 when X-Grepture-Target header is missing", async () => {
    const providers = createTestProviders();
    const app = createTestApp(providers);

    const res = await app.request(makeRequest({ target: null }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Missing X-Grepture-Target");
  });

  it("returns 400 when X-Grepture-Target is a malformed URL", async () => {
    const providers = createTestProviders();
    const app = createTestApp(providers);

    const res = await app.request(makeRequest({ target: "not-a-url" }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.error).toContain("Invalid X-Grepture-Target URL");
  });
});

// ─── Rate limiting ────────────────────────────────────────────────────────

describe("handler errors: rate limiting", () => {
  it("returns 429 with Retry-After when rate limited", async () => {
    const providers = createTestProviders();
    providers.rateQuota = {
      check: async () => ({
        rate: { allowed: false, retryAfter: 30, limit: 100 },
        quota: { allowed: true },
      }),
      checkAiSampling: async () => ({ allowed: true, used: 0, limit: Infinity }),
    };
    const app = createTestApp(providers);

    // Install mock fetch so no real network call is attempted
    const mock = installMockFetch([
      { match: () => true, respond: () => jsonResponse(OPENAI_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(res.headers.get("X-RateLimit-Limit")).toBe("100");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(json.error).toContain("Rate limit exceeded");
    // Should NOT have forwarded upstream
    expect(mock.calls).toHaveLength(0);
  });

  it("returns 429 when quota exceeded", async () => {
    const providers = createTestProviders();
    providers.rateQuota = {
      check: async () => ({
        rate: { allowed: true },
        quota: { allowed: false },
      }),
      checkAiSampling: async () => ({ allowed: true, used: 0, limit: Infinity }),
    };
    const app = createTestApp(providers);

    const mock = installMockFetch([
      { match: () => true, respond: () => jsonResponse(OPENAI_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const res = await app.request(makeRequest());
    const json = await res.json();

    expect(res.status).toBe(429);
    expect(json.error).toContain("quota exceeded");
    expect(mock.calls).toHaveLength(0);
  });

  it("fails open when rateQuota.check throws (request proceeds)", async () => {
    const providers = createTestProviders();
    providers.rateQuota = {
      check: async () => {
        throw new Error("Redis connection failed");
      },
      checkAiSampling: async () => ({ allowed: true, used: 0, limit: Infinity }),
    };
    const app = createTestApp(providers);

    const mock = installMockFetch([
      { match: () => true, respond: () => jsonResponse(OPENAI_TEXT_RESPONSE) },
    ]);
    mockRestore = mock.restore;

    const origError = console.error;
    console.error = () => {};
    const res = await app.request(makeRequest());
    console.error = origError;

    // Should NOT be 429 — request should proceed (fail open)
    expect(res.status).not.toBe(429);
    // The request should have been forwarded upstream
    expect(mock.calls.length).toBeGreaterThan(0);
  });
});

// ─── Upstream errors ──────────────────────────────────────────────────────

describe("handler errors: upstream", () => {
  it("returns 502 when upstream is unreachable (fetch throws)", async () => {
    const providers = createTestProviders();
    const app = createTestApp(providers);

    const mock = installMockFetch([
      {
        match: () => true,
        respond: () => {
          throw new Error("ECONNREFUSED");
        },
      },
    ]);
    mockRestore = mock.restore;

    const origError = console.error;
    console.error = () => {};
    const res = await app.request(makeRequest());
    console.error = origError;

    expect(res.status).toBe(502);
  });
});
