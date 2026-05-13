import type { Context, Next } from "hono";
import { config } from "../config";

export async function geminiMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  if (!greptureKey) return c.json({ error: "Missing Grepture key in URL" }, 401);

  const geminiKey = c.req.header("x-goog-api-key");

  const path = new URL(c.req.url).pathname.replace(/^\/gemini\/[^/]+/, "");
  c.set("injectedTarget" as never, `${config.geminiTarget}${path}` as never);

  if (geminiKey) {
    c.req.raw.headers.set("x-grepture-auth-forward", geminiKey);
  }
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
