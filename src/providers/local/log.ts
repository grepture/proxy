import type { LogWriter } from "../types";
import type { TrafficLogEntry, EmbeddingLogEntry } from "../../types";

export class LocalLogWriter implements LogWriter {
  push(entry: TrafficLogEntry): void {
    console.log(JSON.stringify(entry));
  }

  pushEmbedding(entry: EmbeddingLogEntry): void {
    console.log(JSON.stringify({ kind: "embedding", ...entry }));
  }

  async flush(): Promise<void> {
    // Nothing to flush — entries are written immediately to stdout
  }
}
