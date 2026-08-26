import { describe, it, expect, afterEach } from "bun:test";
import type { ResolvedProviderKey, BudgetMatch } from "../src/providers/types";
import type { RouteModelAction, TrafficLogEntry } from "../src/types";
import { createTestProviders } from "./helpers/test-providers";
import { createTestApp, resetProviders } from "./helpers/create-test-app";
import { installMockFetch } from "./helpers/mock-fetch";
import { OPENAI_TEXT_RESPONSE, jsonResponse } from "./helpers/mock-responses";
import { makeRule } from "./fixtures/rules";

const OPENAI_KEY: ResolvedProviderKey = {
  id: "key-openai-1",
  provider: "openai",
  decrypted: "sk-test-openai",
  default_model: null,
  fallback_key_id: null,
};

function routeAction(overrides: Partial<RouteModelAction> = {}): RouteModelAction {
  return {
    id: "action-route",
    enabled: true,
    type: "route_model",
    target_model: "gpt-4o-mini",
    when: "always",
    budget_pct: 80,
    ...overrides,
  };
}

function budgetMatch(spentPct: number): BudgetMatch {
  return {
    def: {
      id: "budget-1",
      scope_type: "api_key",
      api_settings_id: "test-settings",
      scope_value: null,
      period: "monthly",
      limit_cents: 10_000,
    },
    period_key: "2026-08",
    // limit_cents * 10_000 = micro-cents
    spent_micro_cents: Math.round(10_000 * 10_000 * (spentPct / 100)),
  };
}

function makeRequest(model = "gpt-4o") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer test-grepture-key",
      "X-Grepture-Target": "https://api.openai.com/v1/chat/completions",
    },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "Hello" }] }),
  });
}

let mockRestore: (() => void) | null = null;
let sentBodies: string[] = [];

function mockOpenAI() {
  sentBodies = [];
  const mock = installMockFetch([
    {
      match: (u) => u.includes("openai.com"),
      respond: (_u, init) => {
        sentBodies.push(String(init?.body ?? ""));
        return jsonResponse(OPENAI_TEXT_RESPONSE);
      },
    },
  ]);
  mockRestore = mock.restore;
}

afterEach(() => {
  mockRestore?.();
  mockRestore = null;
  resetProviders();
});

function lastLog(providers: ReturnType<typeof createTestProviders>): TrafficLogEntry {
  const entries = (providers.log as unknown as { entries: TrafficLogEntry[] }).entries;
  return entries[entries.length - 1];
}

describe("route_model: always", () => {
  it("rewrites the model sent upstream and records the requested model", async () => {
    mockOpenAI();
    const providers = createTestProviders([OPENAI_KEY], {
      rules: [makeRule({ apply_to: "input", match_all: true, actions: [routeAction()] })],
    });
    const app = createTestApp(providers);

    const res = await app.request(makeRequest("gpt-4o"));
    expect(res.status).toBe(200);
    expect(JSON.parse(sentBodies[0]).model).toBe("gpt-4o-mini");
    expect(res.headers.get("x-grepture-routed-model")).toBe("gpt-4o->gpt-4o-mini");

    const log = lastLog(providers);
    expect(log.requested_model).toBe("gpt-4o");
    expect(JSON.parse(log.request_body).model).toBe("gpt-4o-mini");
    expect(JSON.parse(log.original_request_body ?? "{}").model).toBe("gpt-4o");
  });

  it("is a no-op when the request already uses the target model", async () => {
    mockOpenAI();
    const providers = createTestProviders([OPENAI_KEY], {
      rules: [makeRule({ apply_to: "input", match_all: true, actions: [routeAction()] })],
    });
    const app = createTestApp(providers);

    const res = await app.request(makeRequest("gpt-4o-mini"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-grepture-routed-model")).toBeNull();
    expect(lastLog(providers).requested_model ?? null).toBeNull();
  });
});

describe("route_model: budget_over_pct", () => {
  it("does not route while spend is under the threshold", async () => {
    mockOpenAI();
    const providers = createTestProviders([OPENAI_KEY], {
      rules: [makeRule({ apply_to: "input", match_all: true, actions: [routeAction({ when: "budget_over_pct", budget_pct: 80 })] })],
      budgets: [budgetMatch(50)],
    });
    const app = createTestApp(providers);

    const res = await app.request(makeRequest("gpt-4o"));
    expect(res.status).toBe(200);
    expect(JSON.parse(sentBodies[0]).model).toBe("gpt-4o");
    expect(res.headers.get("x-grepture-routed-model")).toBeNull();
  });

  it("routes once spend reaches the threshold", async () => {
    mockOpenAI();
    const providers = createTestProviders([OPENAI_KEY], {
      rules: [makeRule({ apply_to: "input", match_all: true, actions: [routeAction({ when: "budget_over_pct", budget_pct: 80 })] })],
      budgets: [budgetMatch(85)],
    });
    const app = createTestApp(providers);

    const res = await app.request(makeRequest("gpt-4o"));
    expect(res.status).toBe(200);
    expect(JSON.parse(sentBodies[0]).model).toBe("gpt-4o-mini");
    expect(res.headers.get("x-grepture-routed-model")).toBe("gpt-4o->gpt-4o-mini");
    expect(lastLog(providers).requested_model).toBe("gpt-4o");
  });

  it("does not route when no budget matches the request", async () => {
    mockOpenAI();
    const providers = createTestProviders([OPENAI_KEY], {
      rules: [makeRule({ apply_to: "input", match_all: true, actions: [routeAction({ when: "budget_over_pct", budget_pct: 80 })] })],
    });
    const app = createTestApp(providers);

    const res = await app.request(makeRequest("gpt-4o"));
    expect(JSON.parse(sentBodies[0]).model).toBe("gpt-4o");
  });
});
