import { createHash, createHmac, randomBytes } from "crypto";
import { config } from "../config";
import type { RequestContext } from "../types";

// Keyed separately from the provider-key encryption that shares the secret.
// Without a configured secret (self-hosted, no GREPTURE_ENCRYPTION_KEY),
// tokens are stable only within one process.
const hmacKey = config.encryptionKey
  ? createHash("sha256").update(`grepture-mask-token:${config.encryptionKey}`).digest()
  : randomBytes(32);

/** Formats 16 bytes as a lowercase UUID (version 8), the shape detokenize finds. */
function toUuid(bytes: Buffer): string {
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Token for a masked value. Random by default. When the caller sends
 * X-Grepture-Token-Scope, the token is an HMAC of the team, that scope and the
 * value, so the same value gets the same token for the whole conversation
 * (keeping prompt caches valid) while differing across scopes and teams.
 */
export function maskToken(ctx: RequestContext, prefix: string, value: string): string {
  if (!ctx.tokenScope) return `${prefix}${crypto.randomUUID()}`;
  const digest = createHmac("sha256", hmacKey)
    .update(`${ctx.auth.team_id}\0${ctx.tokenScope}\0${value}`)
    .digest()
    .subarray(0, 16);
  return `${prefix}${toUuid(Buffer.from(digest))}`;
}

const MAX_SCOPE_LENGTH = 256;

/** Parses X-Grepture-Token-Scope. Returns null when absent. */
export function parseTokenScopeHeader(value: string | undefined): { scope: string | null } | { error: string } {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") return { scope: null };
  if (trimmed.length > MAX_SCOPE_LENGTH) {
    return { error: `Invalid X-Grepture-Token-Scope: at most ${MAX_SCOPE_LENGTH} characters` };
  }
  return { scope: trimmed };
}
