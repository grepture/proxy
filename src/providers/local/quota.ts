import type { QuotaChecker } from "../types";

export class LocalQuotaChecker implements QuotaChecker {
  async check(_teamId: string, _tier: string): Promise<{ allowed: boolean }> {
    return { allowed: true };
  }

  async checkAiSampling(_teamId: string, _tier: string): Promise<{ allowed: boolean; used: number; limit: number }> {
    return { allowed: true, used: 0, limit: Infinity };
  }
}
