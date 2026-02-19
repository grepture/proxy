import { redis } from "../../infra/redis";
import type { TokenVault } from "../types";

export class CloudTokenVault implements TokenVault {
  async set(teamId: string, token: string, value: string, ttl: number): Promise<void> {
    const vaultKey = `grepture:vault:${teamId}:${token}`;
    await redis.set(vaultKey, value, { ex: ttl });
  }

  async get(teamId: string, token: string): Promise<string | null> {
    const vaultKey = `grepture:vault:${teamId}:${token}`;
    return redis.get<string>(vaultKey);
  }
}
