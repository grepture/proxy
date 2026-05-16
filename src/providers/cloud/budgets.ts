import { redis } from "../../infra/redis";
import { supabase } from "../../infra/supabase";
import type { BudgetChecker, BudgetDef, BudgetMatch } from "../types";

const DEFS_TTL = 60;

function periodKey(period: "daily" | "monthly", now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  if (period === "monthly") return `${y}-${m}`;
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function spentKey(budgetId: string, periodKeyValue: string): string {
  return `grepture:budget:spent:${budgetId}:${periodKeyValue}`;
}

function defsKey(teamId: string): string {
  return `grepture:budget:def:${teamId}`;
}

/** TTL for a :spent: counter — slightly longer than the period so it ages out cleanly. */
function spentTtl(period: "daily" | "monthly"): number {
  return period === "daily" ? 36 * 60 * 60 : 33 * 24 * 60 * 60;
}

export class CloudBudgetChecker implements BudgetChecker {
  private async loadDefs(teamId: string): Promise<BudgetDef[]> {
    const key = defsKey(teamId);
    try {
      const cached = await redis.get<BudgetDef[]>(key);
      if (cached) return cached;
    } catch {
      // Redis down — fall through
    }

    const { data, error } = await supabase
      .from("budgets")
      .select("id, scope_type, api_settings_id, scope_value, period, limit_cents")
      .eq("team_id", teamId)
      .eq("enabled", true);

    if (error || !data) return [];

    const defs = data as BudgetDef[];

    redis.set(key, defs, { ex: DEFS_TTL }).catch((err) => {
      console.error("Redis SET budget defs failed:", err);
    });

    return defs;
  }

  async match(
    teamId: string,
    apiSettingsId: string,
    label: string | null,
  ): Promise<BudgetMatch[]> {
    const defs = await this.loadDefs(teamId);
    if (defs.length === 0) return [];

    const relevant = defs.filter((d) => {
      if (d.scope_type === "api_key") return d.api_settings_id === apiSettingsId;
      if (d.scope_type === "label") return label != null && d.scope_value === label;
      return false;
    });

    if (relevant.length === 0) return [];

    const now = new Date();
    const pipe = redis.pipeline();
    const periods: string[] = [];
    for (const def of relevant) {
      const pk = periodKey(def.period, now);
      periods.push(pk);
      pipe.get(spentKey(def.id, pk));
    }

    const results = await pipe.exec<(number | string | null)[]>();

    return relevant.map((def, i) => ({
      def,
      period_key: periods[i],
      spent_micro_cents: Number(results[i] ?? 0),
    }));
  }

  async recordSpend(matches: BudgetMatch[], cost_micro_cents: number): Promise<void> {
    if (matches.length === 0 || cost_micro_cents <= 0) return;

    const pipe = redis.pipeline();
    for (const m of matches) {
      pipe.incrby(spentKey(m.def.id, m.period_key), cost_micro_cents);
    }

    let results: number[] = [];
    try {
      results = await pipe.exec<number[]>();
    } catch (err) {
      console.error("Redis INCRBY budget spend failed:", err);
      return;
    }

    // For freshly-created counters (result === cost_micro_cents on first increment),
    // set an EXPIRE so they age out at period rollover.
    for (let i = 0; i < matches.length; i++) {
      if (results[i] === cost_micro_cents) {
        const m = matches[i];
        redis.expire(spentKey(m.def.id, m.period_key), spentTtl(m.def.period)).catch(() => {});
      }
    }
  }
}
