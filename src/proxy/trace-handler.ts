import type { Context } from "hono";
import { getProviders } from "../providers";
import type { TrafficLogEntry } from "../types";

type TraceEntry = {
  method: string;
  target_url: string;
  status_code: number;
  duration_ms: number;
  request_body: string | null;
  response_body: string | null;
  model: string | null;
  provider: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  trace_id: string | null;
  label: string | null;
  metadata: Record<string, string> | null;
  seq: number | null;
  streaming: boolean;
};

type TracePayload = {
  entries: TraceEntry[];
};

export async function traceHandler(c: Context): Promise<Response> {
  const authHeader = c.req.header("authorization") || "";
  const apiKey = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!apiKey) return c.json({ error: "Missing Authorization header" }, 401);

  const providers = getProviders();
  const auth = await providers.auth.authenticate(apiKey);
  if (!auth) return c.json({ error: "Invalid API key" }, 401);

  let payload: TracePayload;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    return c.json({ error: "entries must be a non-empty array" }, 400);
  }

  const zeroData = auth.zero_data_mode;

  for (const entry of payload.entries) {
    const logEntry: TrafficLogEntry = {
      user_id: auth.user_id,
      team_id: auth.team_id,
      method: entry.method || "POST",
      target_url: zeroData ? redactUrl(entry.target_url) : (entry.target_url || ""),
      status_code: entry.status_code || 0,
      rules_applied: [],
      duration_ms: Math.round(entry.duration_ms || 0),
      request_headers: {},
      request_body: zeroData ? "" : (entry.request_body || "").slice(0, 50_000),
      response_headers: {},
      response_body: zeroData ? "" : (entry.response_body || "").slice(0, 50_000),
      prompt_tokens: entry.prompt_tokens ?? null,
      completion_tokens: entry.completion_tokens ?? null,
      total_tokens: entry.total_tokens ?? null,
      model: entry.model ?? null,
      provider: entry.provider ?? null,
      trace_id: entry.trace_id ?? null,
      label: entry.label ?? null,
      metadata: zeroData ? null : (entry.metadata ?? null),
      seq: entry.seq ?? null,
      source: "trace",
    };

    providers.log.push(logEntry);
  }

  return c.body(null, 204);
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "[redacted]";
  }
}
