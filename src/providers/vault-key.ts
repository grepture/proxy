import { createHash } from "crypto";

/** Vault key for a token; scope-bound entries live under their own namespace. */
export function vaultKey(teamId: string, token: string, scope: string | null): string {
  if (!scope) return `grepture:vault:${teamId}:${token}`;
  const scopeHash = createHash("sha256").update(scope).digest("hex");
  return `grepture:vault:${teamId}:scope:${scopeHash}:${token}`;
}
