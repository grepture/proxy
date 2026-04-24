import { supabase } from "../../infra/supabase";
import type { ToolCallWriter } from "../types";
import type { ToolCallInsertRow, ToolCallLink } from "../../types";

const FLUSH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;

export class CloudToolCallWriter implements ToolCallWriter {
  private inserts: ToolCallInsertRow[] = [];
  private links: Array<{ teamId: string; link: ToolCallLink }> = [];
  private timer: ReturnType<typeof setInterval> | null = null;

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
