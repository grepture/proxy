// One-time backfill: walk traffic_logs oldest-first, extract tool_use blocks
// from response_body (→ insert tool_calls), extract tool_result blocks from
// request_body (→ link pending tool_calls rows).
//
// Usage (from proxy/):
//   bun run scripts/backfill-tool-calls.ts
//
// Environment: requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (read via
// the proxy's config module). Service-role bypasses RLS; backfill is admin-only.
//
// Design notes:
//   - Idempotent per (traffic_log_id, provider_tool_call_id): a re-run after
//     extractor improvements picks up previously-missed calls without
//     duplicating the ones already inserted.
//   - Historical timestamps preserved: inserts override created_at, updates
//     override resolved_at + compute latency_ms from the time gap.
//   - Does NOT use link_tool_call_results RPC — that RPC stamps now(), which
//     would be wrong for backfilled history.
//   - Handles all shapes the extractor supports: Anthropic Messages,
//     OpenAI Chat Completions, OpenAI Responses API, and SSE streams.

import { createHash } from "crypto";
import { createClient } from "@supabase/supabase-js";
import { extractToolUses, providerForRow } from "../src/translation/response";
import { extractToolResults } from "../src/translation/request";

// Backfill creates its own Supabase client rather than using the proxy's
// config module — that module short-circuits credentials when
// GREPTURE_MODE != "cloud", which is awkward for a one-off admin script.
function getAdminSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("SUPABASE_URL is not set. Check proxy/.env.local");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set. Check proxy/.env.local");
  return createClient(url, key);
}

const BATCH_SIZE = 200;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

type TrafficLogRow = {
  id: string;
  team_id: string;
  user_id: string;
  target_url: string;
  request_body: string | null;
  response_body: string | null;
  session_id: string | null;
  trace_id: string | null;
  model: string | null;
  created_at: string;
};

type InsertRow = {
  team_id: string;
  user_id: string;
  traffic_log_id: string;
  session_id: string | null;
  trace_id: string | null;
  provider_tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  arguments_hash: string;
  status: "pending";
  model: string | null;
  provider: "openai" | "anthropic";
  created_at: string;
};

type LinkOp = {
  team_id: string;
  provider_tool_call_id: string;
  result: unknown;
  is_error: boolean;
  result_traffic_log_id: string;
  resolved_at: string;
};

function tryParse(text: string | null): unknown {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

type Counters = { processed: number; inserted: number; linked: number; skipped: number };

async function processTeam(
  supabase: ReturnType<typeof getAdminSupabase>,
  teamId: string,
  counters: Counters,
  startedAt: number,
): Promise<void> {
  let cursor: string | null = null; // last processed created_at (ISO) within this team

  while (true) {
    let q = supabase
      .from("traffic_logs")
      .select("id, team_id, user_id, target_url, request_body, response_body, session_id, trace_id, model, created_at")
      .eq("team_id", teamId)
      .order("created_at", { ascending: true })
      .limit(BATCH_SIZE);
    if (cursor) q = q.gt("created_at", cursor);

    const { data, error } = await q;
    if (error) throw new Error(`traffic_logs fetch failed (team ${teamId}): ${error.message}`);
    if (!data || data.length === 0) break;

    const rows = data as TrafficLogRow[];

    // Per-(traffic_log_id, provider_tool_call_id) idempotency. Lets us
    // re-run after the extractor is upgraded to find new calls in rows
    // where the old extractor already wrote some rows.
    const ids = rows.map((r) => r.id);
    const { data: existing, error: exErr } = await supabase
      .from("tool_calls")
      .select("traffic_log_id, provider_tool_call_id")
      .in("traffic_log_id", ids);
    if (exErr) throw new Error(`idempotency lookup failed: ${exErr.message}`);
    const alreadyKeys = new Set<string>(
      (existing ?? []).map((r: { traffic_log_id: string; provider_tool_call_id: string }) =>
        `${r.traffic_log_id}|${r.provider_tool_call_id}`),
    );

    const inserts: InsertRow[] = [];
    const linkOps: LinkOp[] = [];

    for (const row of rows) {
      // Tool uses in the response (any shape, any stream).
      const parsedResp = tryParse(row.response_body);
      const uses = extractToolUses(parsedResp, row.response_body);
      const provider = providerForRow(uses);
      for (const u of uses) {
        const key = `${row.id}|${u.id}`;
        if (alreadyKeys.has(key)) continue;
        inserts.push({
          team_id: row.team_id,
          user_id: row.user_id,
          traffic_log_id: row.id,
          session_id: row.session_id,
          trace_id: row.trace_id,
          provider_tool_call_id: u.id,
          tool_name: u.name,
          arguments: u.input,
          arguments_hash: hashArgs(u.input),
          status: "pending",
          model: row.model,
          provider: provider ?? "openai",
          created_at: row.created_at,
        });
      }

      // Tool results in the request (any shape, including truncated bodies).
      const parsedReq = tryParse(row.request_body);
      const results = extractToolResults(parsedReq, row.request_body);
      for (const r of results) {
        linkOps.push({
          team_id: row.team_id,
          provider_tool_call_id: r.tool_call_id,
          result: r.result ?? null,
          is_error: r.is_error,
          result_traffic_log_id: row.id,
          resolved_at: row.created_at,
        });
      }

      if (uses.length === 0 && results.length === 0) counters.skipped++;
    }

    if (inserts.length > 0) {
      const { error: insErr } = await supabase.from("tool_calls").insert(inserts);
      if (insErr) {
        console.error(`insert batch failed (${inserts.length} rows):`, insErr.message);
      } else {
        counters.inserted += inserts.length;
      }
    }

    // Links — per-op UPDATE so we can compute latency_ms from stored
    // created_at and stamp the historical resolved_at. This is N+1; acceptable
    // for a one-time backfill. If history is very large, switch to a batched
    // CTE-based SQL statement.
    for (const op of linkOps) {
      const { data: matched, error: mErr } = await supabase
        .from("tool_calls")
        .select("id, created_at")
        .eq("team_id", op.team_id)
        .eq("provider_tool_call_id", op.provider_tool_call_id)
        .eq("status", "pending")
        .limit(1);
      if (mErr || !matched || matched.length === 0) continue;
      const tc = matched[0] as { id: string; created_at: string };
      const latencyMs = Math.max(0, Math.round(new Date(op.resolved_at).getTime() - new Date(tc.created_at).getTime()));
      const { error: updErr } = await supabase
        .from("tool_calls")
        .update({
          result: op.result,
          status: op.is_error ? "error" : "success",
          resolved_at: op.resolved_at,
          latency_ms: latencyMs,
          result_traffic_log_id: op.result_traffic_log_id,
        })
        .eq("id", tc.id);
      if (!updErr) counters.linked++;
    }

    counters.processed += rows.length;
    cursor = rows[rows.length - 1].created_at;

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.log(`[backfill] team=${teamId.slice(0, 8)} t=${elapsed}s processed=${counters.processed} inserted=${counters.inserted} linked=${counters.linked} skipped=${counters.skipped} cursor=${cursor}`);
  }
}

async function run(): Promise<void> {
  const supabase = getAdminSupabase();
  const counters: Counters = { processed: 0, inserted: 0, linked: 0, skipped: 0 };
  const startedAt = Date.now();

  // Enumerate teams from the `teams` table — much cheaper than SELECT DISTINCT
  // on a large traffic_logs, and the per-team query hits idx_traffic_logs_team_created.
  const { data: teams, error: teamsErr } = await supabase
    .from("teams")
    .select("id");
  if (teamsErr) throw new Error(`teams fetch failed: ${teamsErr.message}`);
  if (!teams || teams.length === 0) {
    console.log("[backfill] no teams — nothing to do");
    return;
  }

  console.log(`[backfill] found ${teams.length} teams`);
  for (const team of teams) {
    await processTeam(supabase, team.id, counters, startedAt);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`[backfill] DONE t=${elapsed}s processed=${counters.processed} inserted=${counters.inserted} linked=${counters.linked} skipped=${counters.skipped}`);
}

run().catch((err) => {
  console.error("[backfill] fatal:", err);
  process.exit(1);
});
