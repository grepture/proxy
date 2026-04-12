/**
 * Creates a minimal Hono app with the proxy handler for testing.
 * Does NOT call Bun.serve() or load plugins.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { setProviders, resetProviders } from "../../src/providers";
import { proxyHandler } from "../../src/proxy/handler";
import { registerBuiltinActions } from "../../src/actions/builtin";
import type { Providers } from "../../src/providers";

let actionsRegistered = false;

export function createTestApp(providers: Providers): Hono {
  // Register actions once (they go into a global registry)
  if (!actionsRegistered) {
    registerBuiltinActions();
    actionsRegistered = true;
  }

  setProviders(providers);

  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("requestId" as never, "test-request-id");
    c.header("X-Request-Id", "test-request-id");
    await next();
  });

  app.use("*", cors());
  app.all("/*", proxyHandler);

  return app;
}

export { resetProviders };
