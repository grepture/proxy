import type { LogWriter, DebugTraceEntry } from "../types";
import type { TrafficLogEntry, EmbeddingLogEntry } from "../../types";

export class LocalLogWriter implements LogWriter {
  push(entry: TrafficLogEntry): void {
    console.log(JSON.stringify(entry));
  }

  pushEmbedding(entry: EmbeddingLogEntry): void {
    console.log(JSON.stringify({ kind: "embedding", ...entry }));
  }

  pushDebugTrace(entry: DebugTraceEntry): void {
    console.log(JSON.stringify({ kind: "debug_trace", ...entry }));
  }

  async flush(): Promise<void> {
    // Nothing to flush — entries are written immediately to stdout
  }
}
