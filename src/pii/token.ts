import { createHash, createHmac, randomBytes } from "crypto";
import { config } from "../config";
import type { TokenVault } from "../providers/types";
import type { RequestContext } from "../types";

// Keyed separately from the provider-key encryption that shares the secret.
// Without a configured secret (self-hosted, no GREPTURE_ENCRYPTION_KEY),
// tokens are stable only within one process.
function deriveKey(label: string): Buffer {
  return config.encryptionKey
    ? createHash("sha256").update(`${label}:${config.encryptionKey}`).digest()
    : randomBytes(32);
}
const hmacKey = deriveKey("grepture-mask-token");
// Scope-bound tokens use their own key, so a request in the same scope that
// omits the binding header mints different tokens instead of storing an
// unbound copy of a bound token.
const boundHmacKey = deriveKey("grepture-mask-token-bound");

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
  const digest = createHmac("sha256", ctx.tokenScopeBound ? boundHmacKey : hmacKey)
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

/**
 * Parses X-Grepture-Token-Binding. `scope` binds this request's tokens to its
 * X-Grepture-Token-Scope, so only requests with that scope can restore them.
 */
export function parseTokenBindingHeader(
  value: string | undefined,
  scope: string | null,
): { bound: boolean } | { error: string } {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "" || normalized === "none") return { bound: false };
  if (normalized !== "scope") {
    return { error: "Invalid X-Grepture-Token-Binding: expected \"scope\" or \"none\"" };
  }
  if (!scope) {
    return { error: "X-Grepture-Token-Binding: scope requires X-Grepture-Token-Scope" };
  }
  return { bound: true };
}

/**
 * The vault as seen by one request: stores bind to the request's scope when
 * it opted into binding, and lookups can see entries bound to its scope.
 */
export function requestVault(vault: TokenVault, ctx: RequestContext): TokenVault {
  const scope = ctx.tokenScope ?? null;
  if (!scope) return vault;
  const bindTo = ctx.tokenScopeBound ? scope : null;
  return {
    set: (teamId, token, value, ttl) => vault.set(teamId, token, value, ttl, bindTo),
    get: (teamId, token) => vault.get(teamId, token, scope),
  };
}
