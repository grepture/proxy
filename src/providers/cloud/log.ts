import { supabase } from "../../infra/supabase";
import { buildHotBodyKey, r2Enabled, uploadHotBody } from "../../infra/r2";
import type { LogWriter, DebugTraceEntry } from "../types";
import type { TrafficLogEntry, EmbeddingLogEntry } from "../../types";

const FLUSH_SIZE = 50;
const FLUSH_INTERVAL_MS = 5_000;

// Bodies up to this size are stored inline only — no R2. Matches the prior
// inline body cap (50KB), so PG storage stays flat for typical chat traffic
// and only the long tail (agents, RAG, big tool histories) hits R2.
const INLINE_LIMIT = 50_000;

// When a body is offloaded, this much of it is kept inline in Postgres as a
// preview. Lets the detail-sheet's conversation view render immediately for
// most rows; the full body is fetched from R2 in a second phase.
const PREVIEW_SIZE = 5_000;

// Hard ceiling on inline body storage when R2 is unavailable. Mirrors the
// previous behavior — no row can balloon Postgres if R2 falls over.
const FALLBACK_INLINE_LIMIT = 50_000;

type BodyField = "request_body" | "response_body" | "original_request_body";
type R2KeyField =
  | "request_body_r2_key"
  | "response_body_r2_key"
  | "original_request_body_r2_key";

const BODY_FIELDS: { body: BodyField; key: R2KeyField }[] = [
  { body: "request_body", key: "request_body_r2_key" },
  { body: "response_body", key: "response_body_r2_key" },
  { body: "original_request_body", key: "original_request_body_r2_key" },
];

export class CloudLogWriter implements LogWriter {
  private buffer: TrafficLogEntry[] = [];
  private embeddingBuffer: EmbeddingLogEntry[] = [];
  private debugBuffer: DebugTraceEntry[] = [];
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
      this.flushTraffic();
    }
  }

  pushEmbedding(entry: EmbeddingLogEntry): void {
    this.embeddingBuffer.push(entry);
    this.startTimer();

    if (this.embeddingBuffer.length >= FLUSH_SIZE) {
      this.flushEmbeddings();
    }
  }

  pushDebugTrace(entry: DebugTraceEntry): void {
    this.debugBuffer.push(entry);
    this.startTimer();

    if (this.debugBuffer.length >= FLUSH_SIZE) {
      this.flushDebugTraces();
    }
  }

  async flush(): Promise<void> {
    await Promise.all([
      this.flushTraffic(),
      this.flushEmbeddings(),
      this.flushDebugTraces(),
    ]);
  }

  private async flushTraffic(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer;
    this.buffer = [];

    await offloadLargeBodies(batch);

    try {
      const { error } = await supabase.from("traffic_logs").insert(batch);
      if (error) {
        console.error(`Failed to write ${batch.length} log entries:`, error.message);
      }
    } catch (err) {
      console.error("Log flush failed:", err);
    }
  }

  private async flushEmbeddings(): Promise<void> {
    if (this.embeddingBuffer.length === 0) return;

    const batch = this.embeddingBuffer;
    this.embeddingBuffer = [];

    try {
      const { error } = await supabase.from("embedding_logs").insert(batch);
      if (error) {
        console.error(`Failed to write ${batch.length} embedding log entries:`, error.message);
      }
    } catch (err) {
      console.error("Embedding log flush failed:", err);
    }
  }

  private async flushDebugTraces(): Promise<void> {
    if (this.debugBuffer.length === 0) return;

    const batch = this.debugBuffer;
    this.debugBuffer = [];

    try {
      const rows = batch.map((e) => {
        const row: Record<string, unknown> = {
          team_id: e.team_id,
          user_id: e.user_id,
          traffic_log_id: e.traffic_log_id,
          stages: e.stages,
        };
        if (e.id) row.id = e.id;
        return row;
      });
      const { error } = await supabase.from("debug_traces").insert(rows);
      if (error) {
        console.error(`Failed to write ${batch.length} debug trace entries:`, error.message);
      }
    } catch (err) {
      console.error("Debug trace flush failed:", err);
    }
  }
}

/**
 * For every row in the batch, replace large bodies (> INLINE_LIMIT) with a
 * short preview and upload the full body to R2 in parallel. On R2 failure,
 * fall back to the legacy 50KB inline truncation so the row still lands.
 *
 * Runs entirely off the proxy hot path — `log.push()` returned immediately
 * and the original request has already been responded to by the time this
 * is called.
 */
async function offloadLargeBodies(batch: TrafficLogEntry[]): Promise<void> {
  if (!r2Enabled()) {
    // R2 not configured — preserve legacy behavior.
    for (const row of batch) {
      for (const { body } of BODY_FIELDS) {
        const value = row[body];
        if (typeof value === "string" && value.length > FALLBACK_INLINE_LIMIT) {
          row[body] = value.slice(0, FALLBACK_INLINE_LIMIT);
        }
      }
    }
    return;
  }

  const uploads: Promise<void>[] = [];

  for (const row of batch) {
    if (!row.id || !row.team_id) continue;

    for (const { body, key } of BODY_FIELDS) {
      const value = row[body];
      if (typeof value !== "string" || value.length <= INLINE_LIMIT) continue;

      const r2Key = buildHotBodyKey(row.team_id, row.id, body);
      uploads.push(
        uploadHotBody(r2Key, value).then((ok) => {
          if (ok) {
            row[body] = value.slice(0, PREVIEW_SIZE);
            row[key] = r2Key;
          } else {
            // R2 upload failed — fall back to inline truncation.
            row[body] = value.slice(0, FALLBACK_INLINE_LIMIT);
          }
        }),
      );
    }
  }

  if (uploads.length > 0) {
    await Promise.all(uploads);
  }
}
