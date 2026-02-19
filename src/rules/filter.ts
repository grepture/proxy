import type { Rule } from "../types";

export type Direction = "input" | "output";

export function filterRules(rules: Rule[], direction: Direction): Rule[] {
  return rules.filter((rule) => {
    // Direction check
    if (rule.apply_to !== "both" && rule.apply_to !== direction) return false;

    // Sampling rate check
    if (rule.sampling_rate < 100 && Math.random() * 100 >= rule.sampling_rate) return false;

    return true;
  });
}
