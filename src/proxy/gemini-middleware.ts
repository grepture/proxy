import type { Context, Next } from "hono";
import { config } from "../config";
import { bearerApiKey, providerPath } from "./path-scope";

export async function geminiMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  if (!greptureKey) return c.json({ error: "Missing Grepture key in URL" }, 401);

  // OpenAI-compatible clients (e.g. n8n Nod on /v1beta/openai/...) send the
  // key as a bearer token.
  const geminiKey = c.req.header("x-goog-api-key") ?? bearerApiKey(c, "AIza");

  const path = providerPath(c, /^\/gemini\/[^/]+/);
  c.set("injectedTarget" as never, `${config.geminiTarget}${path}` as never);

  if (geminiKey) {
    c.req.raw.headers.set("x-grepture-auth-forward", geminiKey);
  }
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
