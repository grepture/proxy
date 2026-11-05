import { describe, it, expect } from "bun:test";
import { maskToken, parseTokenScopeHeader } from "../src/pii/token";
import type { RequestContext } from "../src/types";

const UUID = /^pii_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ctx = (teamId: string, tokenScope: string | null) =>
  ({ auth: { team_id: teamId }, tokenScope }) as RequestContext;

describe("maskToken", () => {
  it("is random without a scope", () => {
    const a = maskToken(ctx("t1", null), "pii_", "Sarah");
    expect(a).toMatch(UUID);
    expect(maskToken(ctx("t1", null), "pii_", "Sarah")).not.toBe(a);
  });

  it("is stable for the same value, team and scope", () => {
    const a = maskToken(ctx("t1", "conv-1"), "pii_", "Sarah");
    expect(a).toMatch(UUID);
    expect(maskToken(ctx("t1", "conv-1"), "pii_", "Sarah")).toBe(a);
  });

  it("differs across values, scopes and teams", () => {
    const a = maskToken(ctx("t1", "conv-1"), "pii_", "Sarah");
    expect(maskToken(ctx("t1", "conv-1"), "pii_", "Ben")).not.toBe(a);
    expect(maskToken(ctx("t1", "conv-2"), "pii_", "Sarah")).not.toBe(a);
    expect(maskToken(ctx("t2", "conv-1"), "pii_", "Sarah")).not.toBe(a);
  });
});

describe("parseTokenScopeHeader", () => {
  it("returns null when absent", () => {
    expect(parseTokenScopeHeader(undefined)).toEqual({ scope: null });
  });

  it("trims the scope", () => {
    expect(parseTokenScopeHeader(" conv-1 ")).toEqual({ scope: "conv-1" });
  });

  it("rejects overly long scopes", () => {
    expect("error" in parseTokenScopeHeader("x".repeat(257))).toBe(true);
  });
});
