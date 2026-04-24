import { createHash } from "crypto";
import { extractToolUses, providerForRow, type ExtractedToolUse } from "../translation/response";
import { extractToolResults } from "../translation/request";
import type { RequestContext, ToolCallInsertRow, ToolCallLink } from "../types";
import type { ToolCallWriter } from "../providers/types";

// stable JSON stringify with sorted keys — used for arguments_hash so that
// two invocations with the same logical args produce the same hash.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") + "}";
}

function hashArgs(args: Record<string, unknown>): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

/**
 * Walk the parsed request and response bodies and enqueue tool_calls work:
 * - New tool_use blocks in the response → insert rows (status='pending').
 * - tool_result messages in the follow-up request → link updates.
 *
 * `trafficLogId` is the pre-assigned id of the traffic_logs row being
 * written in the same flush cycle — used as FK for both inserts (source of
 * tool_use) and links (location of tool_result).
 *
 * `rawResponseBody` is needed so that SSE-streamed responses can be parsed
 * via the stream reassembler; leave null/undefined for non-streaming.
 */
export function handleToolCalls(
  writer: ToolCallWriter,
  ctx: RequestContext,
  trafficLogId: string,
  responseParsed: unknown,
  model: string | null,
  rawResponseBody?: string | null,
): void {
  // Inserts: tool_use blocks in the assistant response (any shape, any stream).
  try {
    const uses: ExtractedToolUse[] = extractToolUses(responseParsed, rawResponseBody);
    const provider = providerForRow(uses);
    for (const u of uses) {
      const row: ToolCallInsertRow = {
        team_id: ctx.auth.team_id,
        user_id: ctx.auth.user_id,
        traffic_log_id: trafficLogId,
        session_id: ctx.sessionId,
        trace_id: ctx.traceId,
        provider_tool_call_id: u.id,
        tool_name: u.name,
        arguments: u.input,
        arguments_hash: hashArgs(u.input),
        status: "pending",
        model,
        provider,
      };
      writer.pushInsert(row);
    }
  } catch (err) {
    console.error("tool_use extraction failed:", err);
  }

  // Link updates: tool_result payloads the caller sent in this request.
  try {
    const results = extractToolResults(ctx.parsedBody, ctx.body);
    for (const r of results) {
      const link: ToolCallLink = {
        provider_tool_call_id: r.tool_call_id,
        result: r.result ?? null,
        is_error: r.is_error,
        result_traffic_log_id: trafficLogId,
      };
      writer.pushLink(ctx.auth.team_id, link);
    }
  } catch (err) {
    console.error("tool_result extraction failed:", err);
  }
}
