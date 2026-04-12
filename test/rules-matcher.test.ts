import { describe, it, expect } from "bun:test";
import { matchRule, matchRules } from "../src/rules/matcher";
import { makeRule, makeConditionGroup } from "./fixtures/rules";
import type { RuleCondition, RequestContext } from "../src/types";
import type { AuthInfo } from "../src/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    requestId: "test-req",
    auth: {
      team_id: "test-team",
      user_id: "test-user",
      tier: "free",
      fallback_mode: "error",
      zero_data_mode: false,
    } as AuthInfo,
    method: "POST",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    headers: { "content-type": "application/json", "x-custom": "hello" },
    body: JSON.stringify({ model: "gpt-4", messages: [{ role: "user", content: "test" }] }),
    parsedBody: { model: "gpt-4", messages: [{ role: "user", content: "test" }] },
    startedAt: Date.now(),
    traceId: null,
    label: null,
    metadata: null,
    seq: null,
    sessionId: null,
    ...overrides,
  };
}

function cond(
  field: RuleCondition["field"],
  operator: RuleCondition["operator"],
  value: string,
): RuleCondition {
  return { id: "c-1", field, operator, value };
}

// ---------------------------------------------------------------------------
// matchRule
// ---------------------------------------------------------------------------

describe("matchRule", () => {
  describe("match_all flag", () => {
    it("returns true when match_all is true, regardless of conditions", () => {
      const ctx = makeCtx();
      const rule = makeRule({ match_all: true, conditions: [] });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns true when match_all is true even with non-matching conditions", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        match_all: true,
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "equals", "x-fake: nope")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });
  });

  describe("no condition groups", () => {
    it("returns false when conditions array is empty and match_all is false", () => {
      const ctx = makeCtx();
      const rule = makeRule({ match_all: false, conditions: [] });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("exists operator", () => {
    it("returns true when a present header exists", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "exists", "x-custom")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when header is missing", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "exists", "x-missing")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });

    it("returns true when model field exists", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "exists", "")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when model field is absent from parsedBody", () => {
      const ctx = makeCtx({ parsedBody: { messages: [] } });
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "exists", "")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("contains operator", () => {
    it("returns true when header value contains the substring", () => {
      const ctx = makeCtx();
      // x-custom: hello
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "contains", "x-custom: hell")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("is case-insensitive for contains", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "contains", "x-custom: HELL")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when the substring is not present", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "contains", "x-custom: world")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });

    it("matches body containing substring", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("body", "contains", "gpt-4")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("matches model field containing substring", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "contains", "gpt")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });
  });

  describe("equals operator", () => {
    it("returns true on exact match", () => {
      const ctx = makeCtx();
      // content-type header is "application/json"
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            conditions: [cond("header", "equals", "content-type: application/json")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false on partial match", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            conditions: [cond("header", "equals", "content-type: application")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });

    it("returns true when model equals exact value", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "equals", "gpt-4")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when model does not equal value", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "equals", "gpt-3.5-turbo")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });

    it("equals is case-sensitive", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "equals", "GPT-4")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("matches operator (regex)", () => {
    it("returns true when URL matches regex", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("url", "matches", "openai\\.com")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when URL does not match regex", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("url", "matches", "anthropic\\.com")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });

    it("returns false for invalid regex without throwing", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("url", "matches", "[invalid")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });

    it("returns false when field is null and operator is matches", () => {
      const ctx = makeCtx({ parsedBody: {} });
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "matches", "gpt.*")] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("header field parsing", () => {
    it("header without colon: checks for header existence by name", () => {
      const ctx = makeCtx();
      // "content-type" without colon → field value is the header value
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            conditions: [cond("header", "exists", "content-type")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("header with colon: extracts name and expected value for equals", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            conditions: [cond("header", "equals", "content-type: application/json")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("header name lookup is case-insensitive", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            conditions: [cond("header", "equals", "Content-Type: application/json")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });
  });

  describe("AND logic group", () => {
    it("returns true only when all conditions in AND group pass", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "and",
            conditions: [
              cond("model", "equals", "gpt-4"),
              cond("header", "exists", "x-custom"),
            ],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when any condition in AND group fails", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "and",
            conditions: [
              cond("model", "equals", "gpt-4"),
              cond("header", "exists", "x-missing"),
            ],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("OR logic across multiple groups", () => {
    it("returns true when any group matches (first group matches)", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "and",
            conditions: [cond("model", "equals", "gpt-4")],
          }),
          makeConditionGroup({
            logic: "and",
            conditions: [cond("header", "exists", "x-missing")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns true when any group matches (second group matches)", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "and",
            conditions: [cond("header", "exists", "x-missing")],
          }),
          makeConditionGroup({
            logic: "and",
            conditions: [cond("model", "equals", "gpt-4")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when no group matches", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "and",
            conditions: [cond("header", "exists", "x-missing")],
          }),
          makeConditionGroup({
            logic: "and",
            conditions: [cond("model", "equals", "gpt-3.5-turbo")],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("OR logic within a group", () => {
    it("returns true when any condition in OR group passes", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "or",
            conditions: [
              cond("header", "exists", "x-missing"),
              cond("model", "equals", "gpt-4"),
            ],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });

    it("returns false when no condition in OR group passes", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({
            logic: "or",
            conditions: [
              cond("header", "exists", "x-missing"),
              cond("model", "equals", "claude-3"),
            ],
          }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(false);
    });
  });

  describe("empty condition group (vacuous truth)", () => {
    it("returns true for a group with no conditions", () => {
      const ctx = makeCtx();
      const rule = makeRule({
        conditions: [
          makeConditionGroup({ conditions: [] }),
        ],
      });
      expect(matchRule(ctx, rule)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// matchRules
// ---------------------------------------------------------------------------

describe("matchRules", () => {
  it("returns empty array when no rules match", () => {
    const ctx = makeCtx();
    const rules = [
      makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("model", "equals", "claude-3")] }),
        ],
      }),
      makeRule({
        conditions: [
          makeConditionGroup({ conditions: [cond("header", "exists", "x-missing")] }),
        ],
      }),
    ];
    expect(matchRules(ctx, rules)).toEqual([]);
  });

  it("filters and returns only matching rules", () => {
    const ctx = makeCtx();
    const matching = makeRule({ match_all: true });
    const nonMatching = makeRule({
      conditions: [
        makeConditionGroup({ conditions: [cond("model", "equals", "claude-3")] }),
      ],
    });
    const result = matchRules(ctx, [matching, nonMatching]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(matching);
  });

  it("preserves order of matching rules", () => {
    const ctx = makeCtx();
    const r1 = makeRule({ match_all: true });
    const r2 = makeRule({
      conditions: [
        makeConditionGroup({ conditions: [cond("model", "equals", "gpt-4")] }),
      ],
    });
    const r3 = makeRule({
      conditions: [
        makeConditionGroup({ conditions: [cond("header", "exists", "x-custom")] }),
      ],
    });
    const result = matchRules(ctx, [r1, r2, r3]);
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(r1);
    expect(result[1]).toBe(r2);
    expect(result[2]).toBe(r3);
  });

  it("returns all rules when all match", () => {
    const ctx = makeCtx();
    const rules = [
      makeRule({ match_all: true }),
      makeRule({ match_all: true }),
      makeRule({ match_all: true }),
    ];
    expect(matchRules(ctx, rules)).toHaveLength(3);
  });

  it("returns empty array for empty input", () => {
    const ctx = makeCtx();
    expect(matchRules(ctx, [])).toEqual([]);
  });
});
