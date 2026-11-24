import type { Context } from "hono";

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

/**
 * Strips the route prefix (e.g. `/anthropic/<key>`) and any scope segment
 * from the request path, applies the scope as X-Grepture-Token-Scope unless
 * the client sent that header, and returns the provider path.
 */
export function providerPath(c: Context, prefix: RegExp): string {
  const { scope, path } = splitScope(new URL(c.req.url).pathname.replace(prefix, ""));
  if (scope && !c.req.header("x-grepture-token-scope")) {
    c.req.raw.headers.set("x-grepture-token-scope", scope);
  }
  return path;
}

/**
 * The provider key from `Authorization: Bearer`, as sent by OpenAI-compatible
 * clients, when it has the given key prefix. Other bearer tokens (e.g. OAuth)
 * are not API keys and are ignored.
 */
export function bearerApiKey(c: Context, keyPrefix: string): string | undefined {
  const token = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  return token?.startsWith(keyPrefix) ? token : undefined;
}
