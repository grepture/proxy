import { redis } from "../../infra/redis";
import type { RateQuotaChecker } from "../types";

const RATE_LIMITS: Record<string, number> = {
  free: 20,
  pro: 200,
  business: 2_000,
  custom: Infinity,
};

const REQUEST_LIMITS: Record<string, number> = {
  free: 1_000,
  pro: 50_000,
  business: 1_000_000,
  custom: Infinity,
};

const AI_SAMPLING_LIMIT = 25;

export class CloudRateQuotaChecker implements RateQuotaChecker {
  async check(
    teamId: string,
    tier: string,
  ): Promise<{
    rate: { allowed: boolean; retryAfter?: number; limit?: number };
    quota: { allowed: boolean };
  }> {
    const rateLimit = RATE_LIMITS[tier] ?? RATE_LIMITS.free;
    const quotaLimit = REQUEST_LIMITS[tier] ?? REQUEST_LIMITS.free;

    // Both unlimited — skip Redis entirely
    if (rateLimit === Infinity && quotaLimit === Infinity) {
      return {
        rate: { allowed: true, limit: rateLimit },
        quota: { allowed: true },
      };
    }

    const now = new Date();
    const minute = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, "0")}${String(now.getUTCDate()).padStart(2, "0")}${String(now.getUTCHours()).padStart(2, "0")}${String(now.getUTCMinutes()).padStart(2, "0")}`;
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;

    const rateKey = `grepture:ratelimit:${teamId}:${minute}`;
    const quotaKey = `grepture:quota:${teamId}:${month}`;

    // Pipeline both INCRs into a single Redis round-trip
    const pipe = redis.pipeline();
    pipe.incr(rateKey);
    pipe.incr(quotaKey);
    const results = await pipe.exec<[number, number]>();

    const rateCurrent = results[0];
    const quotaCurrent = results[1];

    // Fire-and-forget: set expiry on new keys
    if (rateCurrent === 1) {
      redis.expire(rateKey, 120).catch(() => {});
    }
    if (quotaCurrent === 1) {
      redis.expire(quotaKey, 33 * 24 * 60 * 60).catch(() => {});
    }

    const rateAllowed = rateLimit === Infinity || rateCurrent <= rateLimit;
    const quotaAllowed = quotaLimit === Infinity || quotaCurrent <= quotaLimit;

    return {
      rate: {
        allowed: rateAllowed,
        limit: rateLimit === Infinity ? undefined : rateLimit,
        retryAfter: rateAllowed ? undefined : 60 - now.getUTCSeconds(),
      },
      quota: { allowed: quotaAllowed },
    };
  }

  async checkAiSampling(
    teamId: string,
    tier: string,
  ): Promise<{ allowed: boolean; used: number; limit: number }> {
    if (tier !== "free") {
      return { allowed: true, used: 0, limit: Infinity };
    }

    const now = new Date();
    const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
    const key = `grepture:ai-sampling:${teamId}:${month}`;

    const current = await redis.incr(key);

    if (current === 1) {
      redis.expire(key, 33 * 24 * 60 * 60).catch(() => {});
    }

    return {
      allowed: current <= AI_SAMPLING_LIMIT,
      used: current,
      limit: AI_SAMPLING_LIMIT,
    };
  }
}
