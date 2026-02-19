import type { PiiCategory } from "../types";
import { piiPatterns } from "./patterns";

export type PiiMatch = {
  category: PiiCategory;
  match: string;
  start: number;
  end: number;
};

export function detectPii(text: string, categories: PiiCategory[]): PiiMatch[] {
  const matches: PiiMatch[] = [];

  for (const category of categories) {
    if (category === "name") {
      console.warn("PII category 'name' is not supported in v1 — skipping");
      continue;
    }

    const patterns = piiPatterns[category];
    if (!patterns) continue;

    for (const pattern of patterns) {
      // Reset lastIndex for global regexes
      const regex = new RegExp(pattern.source, pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = regex.exec(text)) !== null) {
        matches.push({
          category,
          match: m[0],
          start: m.index,
          end: m.index + m[0].length,
        });
      }
    }
  }

  // Sort by position, dedupe overlaps (keep earliest/longest)
  matches.sort((a, b) => a.start - b.start || b.end - a.end);

  const deduped: PiiMatch[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      deduped.push(m);
      lastEnd = m.end;
    }
  }

  return deduped;
}
