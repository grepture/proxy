import { describe, it, expect, afterEach } from "bun:test";
import type { RouteModelAction } from "../src/types";
import { parseTimeoutHeader, resolveTimeoutMs } from "../src/proxy/timeout";
import { forwardRequest } from "../src/proxy/forward";
import type { RequestContext } from "../src/types";
import { createTestProviders } from "./helpers/test-providers";
import { createTestApp, resetProviders } from "./helpers/create-test-app";
import { installMockFetch, type FetchCall } from "./helpers/mock-fetch";
import { OPENAI_TEXT_RESPONSE, jsonResponse } from "./helpers/mock-responses";
import { makeRule } from "./fixtures/rules";

describe("parseTimeoutHeader", () => {
  it("returns null when absent or empty", () => {
    expect(parseTimeoutHeader(undefined)).toBeNull();
    expect(parseTimeoutHeader("  ")).toBeNull();
  });

  it("parses whole seconds", () => {
    expect(parseTimeoutHeader(" 480 ")).toEqual({ seconds: 480 });
  });

  it("rejects non-integers, zero and negatives", () => {
    for (const value of ["abc", "1.5", "0", "-5", "10s"]) {
      expect(parseTimeoutHeader(value)).toHaveProperty("error");
    }
  });
});

describe("resolveTimeoutMs", () => {
  it("uses the shortest rule timeout when no header is sent", () => {
    expect(resolveTimeoutMs([60, 255], null, 600)).toBe(60_000);
  });

  it("falls back to the server max without rules", () => {
    expect(resolveTimeoutMs([], null, 600)).toBe(600_000);
  });

  it("lets the header override rule timeouts in both directions", () => {
    expect(resolveTimeoutMs([60], 480, 600)).toBe(480_000);
    expect(resolveTimeoutMs([255], 30, 600)).toBe(30_000);
  });

  it("caps the header at the server max", () => {
    expect(resolveTimeoutMs([60], 3600, 600)).toBe(600_000);
  });
});

// ─── Through the handler ─────────────────────────────────────────────────────

const routeAction: RouteModelAction = {
  id: "action-route",
  enabled: true,
  type: "route_model",
  target_model: "gpt-4o-mini",
  when: "always",
  budget_pct: 80,
};

// A rule that always applies, with a 1s timeout.
const shortRule = () => makeRule({ apply_to: "input", match_all: true, timeout_seconds: 1, actions: [routeAction] });

function makeRequest(timeoutHeader?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: "Bearer test-grepture-key",
    "X-Grepture-Target": "https://api.openai.com/v1/chat/completions",
    "X-Grepture-Auth-Forward": "Bearer sk-test",
  };
  if (timeoutHeader !== undefined) headers["X-Grepture-Timeout"] = timeoutHeader;
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] }),
  });
}

let mockRestore: (() => void) | null = null;
let calls: FetchCall[] = [];

function mockSlowOpenAI(delayMs: number) {
  const mock = installMockFetch([
    {
      match: (u) => u.includes("openai.com"),
      respond: async (_u, init) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          init?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("aborted", "AbortError"));
          });
        });
        return jsonResponse(OPENAI_TEXT_RESPONSE);
      },
    },
  ]);
  mockRestore = mock.restore;
  calls = mock.calls;
}

afterEach(() => {
  mockRestore?.();
  mockRestore = null;
  resetProviders();
});

describe("X-Grepture-Timeout in the handler", () => {
  it("rule timeout applies without the header", async () => {
    mockSlowOpenAI(1500);
    const app = createTestApp(createTestProviders([], { rules: [shortRule()] }));
    const res = await app.request(makeRequest());
    expect(res.status).toBe(504);
  });

  it("header extends past a shorter rule timeout", async () => {
    mockSlowOpenAI(1500);
    const app = createTestApp(createTestProviders([], { rules: [shortRule()] }));
    const res = await app.request(makeRequest("3"));
    expect(res.status).toBe(200);
  });

  it("header can shorten the wait", async () => {
    mockSlowOpenAI(1500);
    const app = createTestApp(createTestProviders());
    const res = await app.request(makeRequest("1"));
    expect(res.status).toBe(504);
  });

  it("is not forwarded upstream", async () => {
    mockSlowOpenAI(0);
    const app = createTestApp(createTestProviders());
    await app.request(makeRequest("30"));
    expect(Object.keys(calls[0].headers).map((k) => k.toLowerCase())).not.toContain("x-grepture-timeout");
  });

  it("rejects an invalid value with 400", async () => {
    mockSlowOpenAI(0);
    const app = createTestApp(createTestProviders());
    const res = await app.request(makeRequest("ten"));
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });
});

describe("forwardRequest socket idle timeout", () => {
  it("disables Bun's 5-minute default socket idle timeout", async () => {
    const original = globalThis.fetch;
    let seenTimeout: unknown;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenTimeout = init?.timeout;
      return jsonResponse(OPENAI_TEXT_RESPONSE);
    }) as typeof fetch;
    try {
      const ctx = { method: "POST", headers: {}, body: "{}", targetUrl: "https://api.openai.com/v1/chat/completions" } as RequestContext;
      await forwardRequest(ctx, 600_000);
    } finally {
      globalThis.fetch = original;
    }
    expect(seenTimeout).toBe(false);
  });
});
