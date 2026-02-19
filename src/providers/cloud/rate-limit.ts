import { redis } from "../../infra/redis";
import type { RateLimiter } from "../types";

const RATE_LIMITS: Record<string, number> = {
  free: 20,
  pro: 200,
  business: 2_000,
  custom: Infinity,
};

export class CloudRateLimiter implements RateLimiter {
  async check(
    teamId: string,
    tier: string,
  ): Promise<{ allowed: boolean; retryAfter?: number; limit?: number }> {
    const limit = RATE_LIMITS[tier] ?? RATE_LIMITS.free;
    if (limit === Infinity) return { allowed: true, limit };

    const now = new Date();
    const minute = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const key = `grepture:ratelimit:${teamId}:${minute}`;

    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, 120);
    }

    if (current > limit) {
      const retryAfter = 60 - now.getUTCSeconds();
      return { allowed: false, limit, retryAfter };
    }

    return { allowed: true, limit };
  }
}
