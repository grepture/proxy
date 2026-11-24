import type { Context, Next } from "hono";
import { config } from "../config";

/**
 * Generic OpenAI-compatible clients (e.g. n8n Nod) send the legacy `max_tokens`,
 * which newer OpenAI models (gpt-5.x, o-series) reject. OpenAI accepts
 * `max_completion_tokens` on every chat model, so rename it. Returns true if
 * the body changed.
 */
export function normalizeMaxTokens(body: Record<string, unknown>): boolean {
  if (!("max_tokens" in body)) return false;
  if (!("max_completion_tokens" in body)) body.max_completion_tokens = body.max_tokens;
  delete body.max_tokens;
  return true;
}

/**
 * Splits an optional `/scope/<scope>` segment off the path after the Grepture
 * key, for clients that can't send X-Grepture-Token-Scope (e.g. n8n Nod):
 * `/openai/<key>/scope/<scope>/v1/...`.
 */
export function splitScope(path: string): { scope: string | null; path: string } {
  const m = path.match(/^\/scope\/([^/]+)(\/.*)?$/);
  if (!m) return { scope: null, path };
  let scope: string;
  try {
    scope = decodeURIComponent(m[1]);
  } catch {
    scope = m[1];
  }
  return { scope, path: m[2] ?? "/" };
}

export async function openaiMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  if (!greptureKey) return c.json({ error: "Missing Grepture key in URL" }, 401);

  const openaiAuth = c.req.header("authorization");

  const split = splitScope(new URL(c.req.url).pathname.replace(/^\/openai\/[^/]+/, ""));
  const path = split.path;
  if (split.scope && !c.req.header("x-grepture-token-scope")) {
    c.req.raw.headers.set("x-grepture-token-scope", split.scope);
  }
  c.set("injectedTarget" as never, `${config.openaiTarget}${path}` as never);

  if (path === "/v1/chat/completions") {
    try {
      const parsed: unknown = JSON.parse(await c.req.raw.clone().text());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const body = parsed as Record<string, unknown>;
        if (normalizeMaxTokens(body)) c.set("injectedBody" as never, JSON.stringify(body) as never);
      }
    } catch { /* not JSON, leave as-is */ }
  }

  if (openaiAuth) {
    c.req.raw.headers.set("x-grepture-auth-forward", openaiAuth);
  }
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
