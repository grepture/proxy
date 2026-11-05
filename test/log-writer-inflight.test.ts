import { describe, it, expect, mock } from "bun:test";
import type { TrafficLogEntry } from "../src/types";

// A traffic_logs insert that stays pending until we release it, simulating a
// timer/threshold flush stuck mid-write (e.g. in R2 offload or a slow insert).
let releaseInsert: () => void = () => {};
let committed = false;

mock.module("../src/infra/supabase", () => ({
  supabase: {
    from() {
      return {
        insert() {
          return new Promise<{ error: null }>((resolve) => {
            releaseInsert = () => {
              committed = true;
              resolve({ error: null });
            };
          });
        },
      };
    },
  },
}));

mock.module("../src/infra/r2", () => ({
  r2Enabled: () => false,
  buildHotBodyKey: () => "",
  uploadHotBody: async () => true,
}));

const { CloudLogWriter } = await import("../src/providers/cloud/log");

describe("CloudLogWriter.flush — in-flight batches", () => {
  it("waits for a traffic batch already drained by an earlier flush", async () => {
    const log = new CloudLogWriter();
    log.push({ id: "a", team_id: "t" } as TrafficLogEntry);

    // First flush drains the buffer and is now stuck on the insert.
    const first = log.flush();

    // A dependent writer (tool_calls) flushes next. The buffer is empty, but
    // the parent row isn't committed yet — this must not resolve early.
    let secondDone = false;
    const second = log.flush().then(() => { secondDone = true; });

    await new Promise((r) => setTimeout(r, 10));
    expect(secondDone).toBe(false);

    releaseInsert();
    await Promise.all([first, second]);
    expect(committed).toBe(true);
    expect(secondDone).toBe(true);
  });
});
