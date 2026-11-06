import { redis } from "../../infra/redis";
import type { TokenVault } from "../types";
import { vaultKey } from "../vault-key";

export class CloudTokenVault implements TokenVault {
  async set(teamId: string, token: string, value: string, ttl: number, scope: string | null = null): Promise<void> {
    await redis.set(vaultKey(teamId, token, scope), value, { ex: ttl });
  }

  async get(teamId: string, token: string, scope: string | null = null): Promise<string | null> {
    if (!scope) return redis.get<string>(vaultKey(teamId, token, null));
    const [bound, unbound] = await redis.mget<(string | null)[]>(
      vaultKey(teamId, token, scope),
      vaultKey(teamId, token, null),
    );
    return bound ?? unbound;
  }
}
