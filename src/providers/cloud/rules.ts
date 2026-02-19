import { redis } from "../../infra/redis";
import { supabase } from "../../infra/supabase";
import type { RuleProvider } from "../types";
import type { Rule } from "../../types";

const RULES_TTL = 300; // 5 minutes

export class CloudRuleProvider implements RuleProvider {
  async loadRules(teamId: string): Promise<Rule[]> {
    const cacheKey = `grepture:rules:${teamId}`;

    // Check Redis cache
    try {
      const cached = await redis.get<Rule[]>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis down — fall through to Supabase
    }

    // Supabase fallback
    const { data, error } = await supabase
      .from("rules")
      .select("*")
      .eq("team_id", teamId)
      .eq("enabled", true);

    if (error) {
      console.error("Failed to load rules:", error.message);
      return [];
    }

    const rules = (data ?? []) as Rule[];

    // Cache (fire-and-forget)
    redis.set(cacheKey, rules, { ex: RULES_TTL }).catch((err) => {
      console.error("Redis SET rules failed:", err);
    });

    return rules;
  }
}
