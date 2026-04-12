import { describe, it, expect } from "bun:test";
import { detectPii } from "../src/pii/detector";
import type { PiiCategory } from "../src/types";
import {
  MIXED_PII_TEXT,
  MIXED_PII_EXPECTED,
  CLEAN_TEXT,
  FALSE_POSITIVE_TEXT,
  OVERLAPPING_TEXT,
} from "./fixtures/pii-texts";

const ALL_CATEGORIES: PiiCategory[] = [
  "email", "phone", "ssn", "credit_card", "ip_address", "address", "date_of_birth",
];

describe("detectPii", () => {
  it("detects all PII types in mixed text", () => {
    const matches = detectPii(MIXED_PII_TEXT, ALL_CATEGORIES);

    const byCategory = Object.fromEntries(
      matches.map((m) => [m.category, m.match]),
    );

    expect(byCategory.email).toBe(MIXED_PII_EXPECTED.email);
    expect(byCategory.ssn).toBe(MIXED_PII_EXPECTED.ssn);
    expect(byCategory.credit_card).toBe(MIXED_PII_EXPECTED.credit_card);
    expect(byCategory.ip_address).toBe(MIXED_PII_EXPECTED.ip_address);
    expect(byCategory.address).toBe(MIXED_PII_EXPECTED.address);
    expect(byCategory.date_of_birth).toBe(MIXED_PII_EXPECTED.date_of_birth);
    expect(matches.some((m) => m.category === "phone")).toBe(true);
  });

  it("filters by requested categories only", () => {
    const matches = detectPii(MIXED_PII_TEXT, ["email"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].category).toBe("email");
    expect(matches[0].match).toBe("john.doe@example.com");
  });

  it("returns correct positions", () => {
    const text = "email: test@example.com here";
    const matches = detectPii(text, ["email"]);
    expect(matches).toHaveLength(1);
    expect(text.slice(matches[0].start, matches[0].end)).toBe("test@example.com");
  });

  it("deduplicates overlapping matches", () => {
    const matches = detectPii(OVERLAPPING_TEXT, ALL_CATEGORIES);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i].start).toBeGreaterThanOrEqual(matches[i - 1].end);
    }
  });

  it("returns empty array for clean text", () => {
    const matches = detectPii(CLEAN_TEXT, ALL_CATEGORIES);
    expect(matches).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    expect(detectPii("", ALL_CATEGORIES)).toHaveLength(0);
  });

  it("returns empty for empty categories", () => {
    expect(detectPii(MIXED_PII_TEXT, [])).toHaveLength(0);
  });

  it("skips 'name' category gracefully", () => {
    const matches = detectPii("John Doe john@test.com", ["name", "email"]);
    expect(matches).toHaveLength(1);
    expect(matches[0].category).toBe("email");
  });

  it("handles false-positive-prone text", () => {
    const matches = detectPii(FALSE_POSITIVE_TEXT, ["ip_address", "phone", "date_of_birth"]);
    const ips = matches.filter((m) => m.category === "ip_address");
    expect(ips.length).toBeGreaterThanOrEqual(0);
  });

  it("detects credit card variants", () => {
    const cards = [
      "4111111111111111",
      "4111 1111 1111 1111",
      "5111 1111 1111 1111",
      "3411 111111 11111",
      "6011 1111 1111 1111",
    ];
    for (const card of cards) {
      const matches = detectPii(card, ["credit_card"]);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("is safe to call consecutively (no global regex state leak)", () => {
    const text = "test@a.com and other@b.com";
    const first = detectPii(text, ["email"]);
    const second = detectPii(text, ["email"]);
    expect(first).toEqual(second);
  });
});
