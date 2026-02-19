import type { RateLimiter } from "../types";

export class LocalRateLimiter implements RateLimiter {
  async check(_teamId: string, _tier: string): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }
}
