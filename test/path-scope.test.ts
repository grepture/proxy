import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { splitScope } from "../src/proxy/path-scope";
import { anthropicByokMiddleware } from "../src/proxy/anthropic-byok-middleware";
import { geminiMiddleware } from "../src/proxy/gemini-middleware";

describe("splitScope", () => {
  test("extracts the scope and keeps the API path", () => {
    expect(splitScope("/scope/nod-desktop/v1/chat/completions")).toEqual({ scope: "nod-desktop", path: "/v1/chat/completions" });
  });

  test("decodes an encoded scope", () => {
    expect(splitScope("/scope/team%3Aben/v1/models")).toEqual({ scope: "team:ben", path: "/v1/models" });
  });

  test("leaves paths without a scope unchanged", () => {
    expect(splitScope("/v1/chat/completions")).toEqual({ scope: null, path: "/v1/chat/completions" });
  });
});

// Runs a middleware and captures what it hands the proxy handler.
async function run(route: string, mw: typeof geminiMiddleware, url: string, headers: Record<string, string>) {
  const app = new Hono();
  app.use(route, mw);
  app.all("/*", (c) => c.json({
    target: c.get("injectedTarget" as never),
    forward: c.req.header("x-grepture-auth-forward") ?? null,
    scope: c.req.header("x-grepture-token-scope") ?? null,
  }));
  const res = await app.request(url, { method: "POST", headers });
  return res.json();
}

describe("OpenAI-compatible clients on provider routes", () => {
  test("Anthropic route takes a bearer API key and a path scope", async () => {
    const r = await run("/anthropic/:greptureKey/*", anthropicByokMiddleware,
      "http://x/anthropic/grp_k/scope/nod/v1/chat/completions", { authorization: "Bearer sk-ant-api03-abc" });
    expect(r).toEqual({ target: "https://api.anthropic.com/v1/chat/completions", forward: "sk-ant-api03-abc", scope: "nod" });
  });

  test("Anthropic route ignores bearer tokens that aren't API keys", async () => {
    const r = await run("/anthropic/:greptureKey/*", anthropicByokMiddleware,
      "http://x/anthropic/grp_k/v1/messages", { authorization: "Bearer sk-ant-oat01-abc" });
    expect(r.forward).toBeNull();
  });

  test("Gemini route takes a bearer API key and a path scope", async () => {
    const r = await run("/gemini/:greptureKey/*", geminiMiddleware,
      "http://x/gemini/grp_k/scope/nod/v1beta/openai/chat/completions", { authorization: "Bearer AIzaXYZ" });
    expect(r).toEqual({ target: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", forward: "AIzaXYZ", scope: "nod" });
  });
});
