import type { RateQuotaChecker } from "../types";

export class LocalRateQuotaChecker implements RateQuotaChecker {
  async check(_teamId: string, _tier: string) {
    return {
      rate: { allowed: true as const },
      quota: { allowed: true as const },
    };
  }

  async checkAiSampling(_teamId: string, _tier: string) {
    return { allowed: true as const, used: 0, limit: Infinity };
  }
}
