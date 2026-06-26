import { describe, it, expect, mock, beforeEach } from "bun:test";
import type { ToolCallInsertRow, ToolCallLink } from "../src/types";
import type { LogWriter } from "../src/providers/types";

// Records the global order of side effects so we can assert that parent
// traffic_logs are committed (log.flush) before any tool_calls FK insert/link.
let events: string[] = [];

// Stub the supabase client the writer talks to. `from(table).insert()` and
// `rpc()` just record that they ran — we only care about ordering vs log.flush.
mock.module("../src/infra/supabase", () => ({
  supabase: {
    from() {
      return {
        async insert() {
          events.push("toolcalls:insert");
          return { error: null };
        },
      };
    },
    async rpc() {
      events.push("toolcalls:link");
      return { error: null };
    },
  },
}));

// Imported after the mock so it binds to the stubbed module.
const { CloudToolCallWriter } = await import("../src/providers/cloud/tool-calls");

function makeLog(): LogWriter {
  return {
    push() {},
    pushEmbedding() {},
    pushDebugTrace() {},
    async flush() {
      events.push("log:flush");
    },
  };
}

const INSERT_ROW: ToolCallInsertRow = {
  team_id: "t",
  user_id: "u",
  traffic_log_id: "ae60812c-25e8-44c7-b8fc-37d0cfa6498c",
  session_id: null,
  trace_id: null,
  provider_tool_call_id: "call_1",
  tool_name: "get_weather",
  arguments: {},
  arguments_hash: "h",
  status: "pending",
  model: "gpt-4o",
  provider: "openai",
};

const LINK: ToolCallLink = {
  provider_tool_call_id: "call_1",
  result: null,
  is_error: false,
  result_traffic_log_id: "ae60812c-25e8-44c7-b8fc-37d0cfa6498c",
};

describe("CloudToolCallWriter — FK ordering", () => {
  beforeEach(() => {
    events = [];
  });

  it("flushes parent traffic_logs before inserting tool_calls", async () => {
    const writer = new CloudToolCallWriter(makeLog());
    writer.pushInsert(INSERT_ROW);
    await writer.flush();

    expect(events).toEqual(["log:flush", "toolcalls:insert"]);
  });

  it("flushes parent traffic_logs before linking tool_results", async () => {
    const writer = new CloudToolCallWriter(makeLog());
    writer.pushLink("t", LINK);
    await writer.flush();

    expect(events).toEqual(["log:flush", "toolcalls:link"]);
  });

  it("commits parents before both inserts and links in one flush", async () => {
    const writer = new CloudToolCallWriter(makeLog());
    writer.pushInsert(INSERT_ROW);
    writer.pushLink("t", LINK);
    await writer.flush();

    // log.flush must come first; insert precedes link within the flush.
    expect(events[0]).toBe("log:flush");
    expect(events).toContain("toolcalls:insert");
    expect(events).toContain("toolcalls:link");
  });
});
