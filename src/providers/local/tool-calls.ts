import type { ToolCallWriter } from "../types";
import type { ToolCallInsertRow, ToolCallLink } from "../../types";

export class LocalToolCallWriter implements ToolCallWriter {
  pushInsert(row: ToolCallInsertRow): void {
    console.log(JSON.stringify({ kind: "tool_call_insert", row }));
  }

  pushLink(teamId: string, link: ToolCallLink): void {
    console.log(JSON.stringify({ kind: "tool_call_link", team_id: teamId, link }));
  }

  async flush(): Promise<void> {
    // entries written immediately to stdout
  }
}
