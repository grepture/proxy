import type { Context, Next } from "hono";
import { config } from "../config";

export async function openaiMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  if (!greptureKey) return c.json({ error: "Missing Grepture key in URL" }, 401);

  const openaiAuth = c.req.header("authorization");

  const path = new URL(c.req.url).pathname.replace(/^\/openai\/[^/]+/, "");
  c.set("injectedTarget" as never, `${config.openaiTarget}${path}` as never);

  if (openaiAuth) {
    c.req.raw.headers.set("x-grepture-auth-forward", openaiAuth);
  }
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
