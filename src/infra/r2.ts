// Thin wrapper around Bun's native S3 client, targeted at Cloudflare R2.
// Used by the cloud log writer to offload large request/response bodies out
// of Postgres and into cheap object storage.

let _client: Bun.S3Client | null = null;

function getClient(): Bun.S3Client | null {
  if (_client) return _client;

  const endpoint = process.env.R2_ENDPOINT;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) return null;

  _client = new Bun.S3Client({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region: "auto",
  });
  return _client;
}

export function r2Enabled(): boolean {
  return getClient() !== null;
}

/**
 * Build the R2 key for a single hot body. The hot-bodies/ prefix is separate
 * from the parquet archive (traffic_logs/) so the archive cron can clean it
 * up without affecting the cold-storage parquet files.
 */
export function buildHotBodyKey(
  teamId: string,
  logId: string,
  field: "request_body" | "response_body" | "original_request_body",
): string {
  return `hot-bodies/${teamId}/${logId}/${field}.json`;
}

/**
 * Upload a body string to R2. Returns true on success, false on failure —
 * callers fall back to inline truncation when this returns false.
 */
export async function uploadHotBody(key: string, body: string): Promise<boolean> {
  const client = getClient();
  if (!client) return false;

  try {
    await client.write(key, body, { type: "application/json" });
    return true;
  } catch (err) {
    console.error(`R2 upload failed for ${key}:`, err);
    return false;
  }
}
