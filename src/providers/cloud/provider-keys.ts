import { redis } from "../../infra/redis";
import { supabase } from "../../infra/supabase";
import { decrypt } from "../../infra/encryption";
import type { ProviderKeyResolver, ResolvedProviderKey } from "../types";

const PKEY_TTL = 300; // seconds (5 min — matches auth cache)

// Internal shape — what's actually cached in Redis (no plaintext!)
type StoredKeyRow = {
  id: string;
  team_id: string;
  provider: string;
  encrypted_key: string;
  default_model: string | null;
  fallback_key_id: string | null;
};

export class CloudProviderKeyResolver implements ProviderKeyResolver {
  /** Resolve a team's primary key for a given provider. */
  async resolve(teamId: string, provider: string): Promise<ResolvedProviderKey | null> {
    const cacheKey = `grepture:pkey:${teamId}:${provider}`;
    const row = await this.fetchByTeamAndProvider(teamId, provider, cacheKey);
    if (!row) return null;
    return decryptRow(row);
  }

  /** Resolve a key by its UUID — used to follow the fallback chain. */
  async resolveById(keyId: string): Promise<ResolvedProviderKey | null> {
    const cacheKey = `grepture:pkey-id:${keyId}`;
    const row = await this.fetchById(keyId, cacheKey);
    if (!row) return null;
    return decryptRow(row);
  }

  /**
   * Resolve the full fallback chain. Returns [primary, fallback1, ...].
   * Cycle protection: stops if it sees the same key twice. Length cap: maxHops.
   */
  async resolveChain(
    teamId: string,
    provider: string,
    maxHops = 5,
  ): Promise<ResolvedProviderKey[]> {
    const chain: ResolvedProviderKey[] = [];
    const seen = new Set<string>();

    const primary = await this.resolve(teamId, provider);
    if (!primary) return chain;
    chain.push(primary);
    seen.add(primary.id);

    let nextId = primary.fallback_key_id;
    while (nextId && chain.length < maxHops) {
      if (seen.has(nextId)) break; // cycle
      const next = await this.resolveById(nextId);
      if (!next) break;
      chain.push(next);
      seen.add(next.id);
      nextId = next.fallback_key_id;
    }

    return chain;
  }

  private async fetchByTeamAndProvider(
    teamId: string,
    provider: string,
    cacheKey: string,
  ): Promise<StoredKeyRow | null> {
    // Check Redis cache (encrypted blob only)
    try {
      const cached = await redis.get<StoredKeyRow>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis down — fall through to Supabase
    }

    const { data, error } = await supabase
      .from("provider_keys")
      .select("id, team_id, provider, encrypted_key, default_model, fallback_key_id")
      .eq("team_id", teamId)
      .eq("provider", provider)
      .eq("is_primary", true)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as StoredKeyRow;

    // Cache the encrypted row only — never plaintext
    redis.set(cacheKey, row, { ex: PKEY_TTL }).catch((err) => {
      console.error("Redis SET pkey failed:", err);
    });

    return row;
  }

  private async fetchById(
    keyId: string,
    cacheKey: string,
  ): Promise<StoredKeyRow | null> {
    try {
      const cached = await redis.get<StoredKeyRow>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis down — fall through
    }

    const { data, error } = await supabase
      .from("provider_keys")
      .select("id, team_id, provider, encrypted_key, default_model, fallback_key_id")
      .eq("id", keyId)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as StoredKeyRow;

    redis.set(cacheKey, row, { ex: PKEY_TTL }).catch((err) => {
      console.error("Redis SET pkey-id failed:", err);
    });

    return row;
  }
}

function decryptRow(row: StoredKeyRow): ResolvedProviderKey {
  return {
    id: row.id,
    provider: row.provider,
    decrypted: decrypt(row.encrypted_key),
    default_model: row.default_model,
    fallback_key_id: row.fallback_key_id,
  };
}
