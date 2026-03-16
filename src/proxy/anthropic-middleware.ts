import type { Context, Next } from "hono";
import { config } from "../config";

export async function anthropicMiddleware(c: Context, next: Next) {
  const anthropicKey = c.req.header("x-api-key");
  const greptureKey = c.req.header("x-grepture-api-key");

  if (!anthropicKey) {
    return c.json({ error: "Missing x-api-key header" }, 401);
  }

  // Inject target URL so proxyHandler knows where to forward
  const path = new URL(c.req.url).pathname.replace(/^\/claude/, "");
  c.set("injectedTarget" as never, `${config.anthropicTarget}${path}` as never);

  // Set auth-forward header so forward.ts maps it to x-api-key on outbound
  c.req.raw.headers.set("x-grepture-auth-forward", anthropicKey);

  // If Grepture key provided, use it for auth; otherwise use Anthropic key
  if (greptureKey) {
    c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);
  }

  await next();
}
