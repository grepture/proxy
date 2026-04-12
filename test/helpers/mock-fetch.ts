/**
 * Intercepts globalThis.fetch for tests. Rules are matched in order —
 * first match wins. Unmatched requests return 500.
 */

export type FetchCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
};

export type FetchRule = {
  match: (url: string) => boolean;
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>;
};

export function installMockFetch(rules: FetchRule[]): {
  restore: () => void;
  calls: FetchCall[];
} {
  const originalFetch = globalThis.fetch;
  const calls: FetchCall[] = [];

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h);
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });

    for (const rule of rules) {
      if (rule.match(url)) return rule.respond(url, init);
    }

    return new Response(JSON.stringify({ error: "No mock matched", url }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return {
    restore: () => { globalThis.fetch = originalFetch; },
    calls,
  };
}
