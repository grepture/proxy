import type { Context, Next } from "hono";
import { config } from "../config";

export async function cursorMiddleware(c: Context, next: Next) {
  const greptureKey = c.req.param("greptureKey");
  const openaiAuth = c.req.header("authorization"); // "Bearer sk-..."

  if (!openaiAuth) {
    return c.json({ error: "Missing Authorization header" }, 401);
  }

  // Strip /cursor/:greptureKey prefix — remainder includes /v1/...
  const path = new URL(c.req.url).pathname.replace(/^\/cursor\/[^/]+/, "");

  // Cursor sends Responses API format (input:[]) to /v1/chat/completions for newer models.
  // Forward to /v1/responses (stripping unsupported params) and translate the response
  // SSE events back to Chat Completions format so Cursor can render them.
  let resolvedPath = path;
  if (path === "/v1/chat/completions") {
    try {
      const bodyText = await c.req.raw.clone().text();
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      if (Array.isArray(parsed.input) && !parsed.messages) {
        resolvedPath = "/v1/responses";
        // stream_options is not supported by the Responses API
        delete parsed.stream_options;
        c.set("injectedBody" as never, JSON.stringify(parsed) as never);
        c.set("translateResponsesToChat" as never, true as never);
      }
    } catch { /* not JSON or clone failed, leave as-is */ }
  }

  c.set("injectedTarget" as never, `${config.openaiTarget}${resolvedPath}` as never);

  // Store OpenAI key so forward.ts maps it to Authorization on outbound
  c.req.raw.headers.set("x-grepture-auth-forward", openaiAuth);

  // Set Grepture key as Authorization so handler.ts can authenticate
  c.req.raw.headers.set("authorization", `Bearer ${greptureKey}`);

  await next();
}
