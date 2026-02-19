import { supabase } from "../../infra/supabase";
import type { LogWriter } from "../types";
import type { TrafficLogEntry } from "../../types";

const FLUSH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;

export class CloudLogWriter implements LogWriter {
  private buffer: TrafficLogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  private startTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush();
    }, FLUSH_INTERVAL_MS);
  }

  push(entry: TrafficLogEntry): void {
    this.buffer.push(entry);
    this.startTimer();

    if (this.buffer.length >= FLUSH_SIZE) {
      this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    try {
      const { error } = await supabase.from("traffic_logs").insert(batch);
      if (error) {
        console.error(`Failed to write ${batch.length} log entries:`, error.message);
      }
    } catch (err) {
      console.error("Log flush failed:", err);
    }
  }
}
