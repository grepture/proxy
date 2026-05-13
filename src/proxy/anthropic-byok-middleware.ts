import type { Context, Next } from "hono";
import { config } from "../config";

export async function anthropicByokMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  if (!greptureKey) return c.json({ error: "Missing Grepture key in URL" }, 401);

  const anthropicKey = c.req.header("x-api-key");

  const path = new URL(c.req.url).pathname.replace(/^\/anthropic\/[^/]+/, "");
  c.set("injectedTarget" as never, `${config.anthropicTarget}${path}` as never);

  if (anthropicKey) {
    c.req.raw.headers.set("x-grepture-auth-forward", anthropicKey);
  }
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
