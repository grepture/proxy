import type { Context, Next } from "hono";
import { config } from "../config";
import { bearerApiKey, providerPath } from "./path-scope";

export async function anthropicByokMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  if (!greptureKey) return c.json({ error: "Missing Grepture key in URL" }, 401);

  // OpenAI-compatible clients (e.g. n8n Nod on /v1/chat/completions) send the
  // key as a bearer token.
  const anthropicKey = c.req.header("x-api-key") ?? bearerApiKey(c, "sk-ant-api");

  const path = providerPath(c, /^\/anthropic\/[^/]+/);
  c.set("injectedTarget" as never, `${config.anthropicTarget}${path}` as never);

  if (anthropicKey) {
    c.req.raw.headers.set("x-grepture-auth-forward", anthropicKey);
  }
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
