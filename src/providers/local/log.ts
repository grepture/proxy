import type { LogWriter } from "../types";
import type { TrafficLogEntry } from "../../types";

export class LocalLogWriter implements LogWriter {
  push(entry: TrafficLogEntry): void {
    console.log(JSON.stringify(entry));
  }

  async flush(): Promise<void> {
    // Nothing to flush — entries are written immediately to stdout
  }
}
