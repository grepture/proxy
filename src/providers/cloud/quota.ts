import { redis } from "../../infra/redis";
import type { QuotaChecker } from "../types";

const REQUEST_LIMITS: Record<string, number> = {
  free: 1_000,
  pro: 50_000,
  business: 1_000_000,
  custom: Infinity,
};

const AI_SAMPLING_LIMIT = 25;

export class CloudQuotaChecker implements QuotaChecker {
  async check(teamId: string, tier: string): Promise<{ allowed: boolean }> {
    const limit = REQUEST_LIMITS[tier] ?? REQUEST_LIMITS.free;
    if (limit === Infinity) return { allowed: true };

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `grepture:quota:${teamId}:${month}`;

    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, 33 * 24 * 60 * 60);
    }

    return { allowed: current <= limit };
  }

  async checkAiSampling(teamId: string, tier: string): Promise<{ allowed: boolean; used: number; limit: number }> {
    if (tier !== "free") {
      return { allowed: true, used: 0, limit: Infinity };
    }

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `grepture:ai-sampling:${teamId}:${month}`;

    const current = await redis.incr(key);

    if (current === 1) {
      await redis.expire(key, 33 * 24 * 60 * 60);
    }

    return {
      allowed: current <= AI_SAMPLING_LIMIT,
      used: current,
      limit: AI_SAMPLING_LIMIT,
    };
  }
}
