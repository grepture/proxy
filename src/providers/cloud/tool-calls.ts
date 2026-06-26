import { supabase } from "../../infra/supabase";
import type { LogWriter, ToolCallWriter } from "../types";
import type { ToolCallInsertRow, ToolCallLink } from "../../types";

const FLUSH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;

export class CloudToolCallWriter implements ToolCallWriter {
  private inserts: ToolCallInsertRow[] = [];
  private links: Array<{ teamId: string; link: ToolCallLink }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  // tool_calls.traffic_log_id (and link result_traffic_log_id) are FKs into
  // traffic_logs. Those parent rows are buffered in the LogWriter, which flushes
  // on its own independent timer/threshold. We hold a reference so flush() can
  // commit the parents first and never violate the FK.
  constructor(private readonly log: LogWriter) {}

  private startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush(); }, FLUSH_INTERVAL_MS);
  }

  pushInsert(row: ToolCallInsertRow): void {
    this.inserts.push(row);
    this.startTimer();
    if (this.inserts.length + this.links.length >= FLUSH_SIZE) this.flush();
  }

  pushLink(teamId: string, link: ToolCallLink): void {
    this.links.push({ teamId, link });
    this.startTimer();
    if (this.inserts.length + this.links.length >= FLUSH_SIZE) this.flush();
  }

  async flush(): Promise<void> {
    if (this.inserts.length === 0 && this.links.length === 0) return;

    const insertBatch = this.inserts;
    const linkBatch = this.links;
    this.inserts = [];
    this.links = [];

    // Commit the parent traffic_logs first. Both the inserts (traffic_log_id)
    // and the links (result_traffic_log_id) FK into traffic_logs, whose rows
    // sit in the LogWriter's buffer until it flushes on its own schedule. We
    // capture our batches above *before* awaiting this, so any row pushed
    // during the flush (whose parent isn't in this drain) waits for the next
    // cycle rather than racing ahead of its traffic_log. Without this, a
    // tool_calls insert can reach Postgres before its parent and fail the FK
    // with 23503.
    await this.log.flush();

    // Inserts — fire and forget, log on error.
    if (insertBatch.length > 0) {
      try {
        const { error } = await supabase.from("tool_calls").insert(insertBatch);
        if (error) {
          console.error(`Failed to insert ${insertBatch.length} tool_calls:`, error.message);
        }
      } catch (err) {
        console.error("tool_calls insert flush failed:", err);
      }
    }

    // Links — group per team so each RPC call scopes its UPDATE to one team.
    if (linkBatch.length > 0) {
      const byTeam = new Map<string, ToolCallLink[]>();
      for (const { teamId, link } of linkBatch) {
        const arr = byTeam.get(teamId) ?? [];
        arr.push(link);
        byTeam.set(teamId, arr);
      }
      for (const [teamId, links] of byTeam) {
        try {
          const { error } = await supabase.rpc("link_tool_call_results", {
            p_team_id: teamId,
            p_links: links,
          });
          if (error) {
            console.error(`Failed to link ${links.length} tool_call results (team ${teamId}):`, error.message);
          }
        } catch (err) {
          console.error("tool_calls link flush failed:", err);
        }
      }
    }
  }
}
