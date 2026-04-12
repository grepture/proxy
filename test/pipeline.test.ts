import { describe, it, expect, beforeAll } from "bun:test";
import { runPipeline } from "../src/actions/pipeline";
import { registerBuiltinActions } from "../src/actions/builtin";
import { makeRule, blockAction, logAction } from "./fixtures/rules";
import type { RequestContext, AuthInfo, RuleAction } from "../src/types";
import type { TokenVault, QuotaChecker } from "../src/providers/types";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  registerBuiltinActions();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "test-req",
    auth: {
      team_id: "test-team",
      user_id: "test-user",
      tier: "business",
      fallback_mode: "error",
      zero_data_mode: false,
    } as AuthInfo,
    method: "POST",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-4", messages: [] }),
    parsedBody: { model: "gpt-4", messages: [] },
    startedAt: Date.now(),
    traceId: null,
    label: null,
    metadata: null,
    seq: null,
    sessionId: null,
    ...overrides,
  };
}

const nullVault: TokenVault = {
  set: async () => {},
  get: async () => null,
};

function makeAiAction(type: string): RuleAction {
  return {
    id: "action-ai",
    enabled: true,
    type,
    threshold: 0.5,
    on_detect: "block",
    block_status_code: 403,
    block_message: "AI blocked",
  } as unknown as RuleAction;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runPipeline", () => {
  it("two non-blocking rules: both executed, both in rulesApplied, tags collected", async () => {
    const ctx = makeCtx();
    const rule1 = makeRule({ actions: [logAction("tag-one", "info")] });
    const rule2 = makeRule({ actions: [logAction("tag-two", "warn")] });

    const result = await runPipeline(ctx, [rule1, rule2], nullVault);

    expect(result.blocked).toBe(false);
    expect(result.rulesApplied).toEqual([rule1.id, rule2.id]);
    expect(result.tags).toEqual([
      { severity: "info", label: "tag-one" },
      { severity: "warn", label: "tag-two" },
    ]);
  });

  it("block action short-circuits: second rule skipped, blocked with statusCode/message", async () => {
    const ctx = makeCtx();
    const rule1 = makeRule({ actions: [blockAction(403, "Stop here")] });
    const rule2 = makeRule({ actions: [logAction("should-not-appear")] });

    const result = await runPipeline(ctx, [rule1, rule2], nullVault);

    expect(result.blocked).toBe(true);
    expect(result.statusCode).toBe(403);
    expect(result.message).toBe("Stop here");
    expect(result.rulesApplied).toEqual([rule1.id]);
    expect(result.tags).toEqual([]);
  });

  it("disabled action skipped: tags remain empty", async () => {
    const ctx = makeCtx();
    const disabledAction: RuleAction = { ...logAction("should-not-appear"), enabled: false };
    const rule = makeRule({ actions: [disabledAction] });

    const result = await runPipeline(ctx, [rule], nullVault);

    expect(result.blocked).toBe(false);
    expect(result.tags).toEqual([]);
    expect(result.rulesApplied).toEqual([rule.id]);
  });

  it("unknown action type: silently skipped, rule still in rulesApplied", async () => {
    const ctx = makeCtx();
    const unknownAction = {
      id: "action-unknown",
      enabled: true,
      type: "totally_unknown_action_xyz",
    } as unknown as RuleAction;
    const rule = makeRule({ actions: [unknownAction] });

    const result = await runPipeline(ctx, [rule], nullVault);

    expect(result.blocked).toBe(false);
    expect(result.tags).toEqual([]);
    expect(result.rulesApplied).toEqual([rule.id]);
  });

  it("pro tier + business AI action: skipped (ai_detect_injection is business-only)", async () => {
    const ctx = makeCtx({ auth: { team_id: "t", user_id: "u", tier: "pro", fallback_mode: "error", zero_data_mode: false } });
    const aiAction = makeAiAction("ai_detect_injection");
    const rule = makeRule({ actions: [aiAction] });

    const result = await runPipeline(ctx, [rule], nullVault);

    expect(result.blocked).toBe(false);
    expect(result.tags).toEqual([]);
    expect(result.rulesApplied).toEqual([rule.id]);
  });

  it("free tier + AI action with quota denied: skipped, aiSampling populated", async () => {
    const ctx = makeCtx({ auth: { team_id: "t", user_id: "u", tier: "free", fallback_mode: "error", zero_data_mode: false } });
    const aiAction = makeAiAction("ai_detect_pii");
    const rule = makeRule({ actions: [aiAction] });

    const quota: QuotaChecker = {
      check: async () => ({ allowed: true }),
      checkAiSampling: async () => ({ allowed: false, used: 10, limit: 10 }),
    };

    const result = await runPipeline(ctx, [rule], nullVault, quota);

    expect(result.blocked).toBe(false);
    expect(result.tags).toEqual([]);
    expect(result.aiSampling).toEqual({ used: 10, limit: 10 });
    expect(result.rulesApplied).toEqual([rule.id]);
  });

  it("tags from multiple actions across rules are aggregated", async () => {
    const ctx = makeCtx();
    const rule1 = makeRule({ actions: [logAction("alpha", "info"), logAction("beta", "warn")] });
    const rule2 = makeRule({ actions: [logAction("gamma", "critical")] });

    const result = await runPipeline(ctx, [rule1, rule2], nullVault);

    expect(result.blocked).toBe(false);
    expect(result.tags).toEqual([
      { severity: "info", label: "alpha" },
      { severity: "warn", label: "beta" },
      { severity: "critical", label: "gamma" },
    ]);
    expect(result.rulesApplied).toEqual([rule1.id, rule2.id]);
  });
});
