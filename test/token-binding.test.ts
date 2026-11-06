import { describe, it, expect } from "bun:test";
import { maskToken, parseTokenBindingHeader, requestVault } from "../src/pii/token";
import { LocalTokenVault } from "../src/providers/local/vault";
import { vaultKey } from "../src/providers/vault-key";
import { detokenize } from "../src/actions/tokenize";
import type { RequestContext } from "../src/types";

const TEAM = "t1";
const ctx = (tokenScope: string | null, tokenScopeBound = false) =>
  ({ auth: { team_id: TEAM }, tokenScope, tokenScopeBound }) as RequestContext;

describe("parseTokenBindingHeader", () => {
  it("defaults to unbound when absent, empty or none", () => {
    expect(parseTokenBindingHeader(undefined, "conv-1")).toEqual({ bound: false });
    expect(parseTokenBindingHeader("  ", null)).toEqual({ bound: false });
    expect(parseTokenBindingHeader("None", "conv-1")).toEqual({ bound: false });
  });

  it("binds on scope (case-insensitive) when a scope is present", () => {
    expect(parseTokenBindingHeader(" Scope ", "conv-1")).toEqual({ bound: true });
  });

  it("rejects scope binding without a scope, and unknown values", () => {
    expect(parseTokenBindingHeader("scope", null)).toHaveProperty("error");
    expect(parseTokenBindingHeader("strict", "conv-1")).toHaveProperty("error");
  });
});

describe("maskToken with binding", () => {
  it("is stable within a bound scope but differs from the unbound token", () => {
    const bound = maskToken(ctx("conv-1", true), "pii_", "Sarah");
    expect(maskToken(ctx("conv-1", true), "pii_", "Sarah")).toBe(bound);
    expect(maskToken(ctx("conv-1"), "pii_", "Sarah")).not.toBe(bound);
  });
});

describe("scope-bound vault entries", () => {
  it("keeps the unbound key format unchanged", () => {
    expect(vaultKey(TEAM, "pii_x", null)).toBe(`grepture:vault:${TEAM}:pii_x`);
    expect(vaultKey(TEAM, "pii_x", "conv-1")).not.toBe(vaultKey(TEAM, "pii_x", null));
  });

  it("restores a bound token only under the same scope", async () => {
    const store = new LocalTokenVault();
    const minting = ctx("conv-1", true);
    const token = maskToken(minting, "pii_", "Sarah");
    await requestVault(store, minting).set(TEAM, token, "Sarah", 60);

    const restore = (scope: string | null) =>
      detokenize(`hi ${token}`, TEAM, ["pii_"], requestVault(store, ctx(scope)));
    expect(await restore("conv-1")).toBe("hi Sarah");
    expect(await restore("conv-2")).toBe("hi [TOKEN_EXPIRED]");
    expect(await restore(null)).toBe("hi [TOKEN_EXPIRED]");
  });

  it("still restores unbound tokens under any scope or none", async () => {
    const store = new LocalTokenVault();
    const minting = ctx("conv-1");
    const token = maskToken(minting, "pii_", "Sarah");
    await requestVault(store, minting).set(TEAM, token, "Sarah", 60);

    for (const scope of ["conv-1", "conv-2", null]) {
      expect(await detokenize(token, TEAM, ["pii_"], requestVault(store, ctx(scope)))).toBe("Sarah");
    }
  });
});
