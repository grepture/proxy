import type { BudgetChecker, BudgetMatch } from "../types";

export class LocalBudgetChecker implements BudgetChecker {
  async match(): Promise<BudgetMatch[]> {
    return [];
  }

  async recordSpend(_matches: BudgetMatch[], _cost_micro_cents: number): Promise<void> {
    return;
  }
}
