import { describe, it, expect } from "bun:test";
import { replacePii } from "../src/pii/replacer";
import type { PiiMatch } from "../src/pii/detector";

function makeMatch(
  category: PiiMatch["category"],
  match: string,
  start: number,
): PiiMatch {
  return { category, match, start, end: start + match.length };
}

describe("replacePii", () => {
  describe("placeholder strategy", () => {
    it("replaces with category-specific placeholders", async () => {
      const text = "Email: test@example.com Phone: 555-123-4567";
      const matches = [
        makeMatch("email", "test@example.com", 7),
        makeMatch("phone", "555-123-4567", 31),
      ];
      const result = await replacePii(text, matches, "placeholder");
      expect(result).toBe("Email: [EMAIL_REDACTED] Phone: [PHONE_REDACTED]");
    });

    it("returns original text when matches is empty", async () => {
      const text = "No PII here";
      const result = await replacePii(text, [], "placeholder");
      expect(result).toBe(text);
    });
  });

  describe("hash strategy", () => {
    it("produces deterministic 12-char hex output", async () => {
      const text = "SSN: 123-45-6789";
      const matches = [makeMatch("ssn", "123-45-6789", 5)];
      const result1 = await replacePii(text, matches, "hash");
      const result2 = await replacePii(text, matches, "hash");
      expect(result1).toBe(result2);
      const hash = result1.slice(5);
      expect(hash).toMatch(/^[0-9a-f]{12}$/);
    });
  });

  describe("mask strategy", () => {
    it("masks short values (<=2 chars) as **", async () => {
      const text = "ab";
      const matches = [makeMatch("email", "ab", 0)];
      const result = await replacePii(text, matches, "mask");
      expect(result).toBe("**");
    });

    it("masks 3-4 char values showing first char", async () => {
      const text = "abcd";
      const matches = [makeMatch("email", "abcd", 0)];
      const result = await replacePii(text, matches, "mask");
      expect(result).toBe("a***");
    });

    it("masks longer values showing first and last char", async () => {
      const text = "test@example.com";
      const matches = [makeMatch("email", "test@example.com", 0)];
      const result = await replacePii(text, matches, "mask");
      expect(result).toBe("t" + "*".repeat(14) + "m");
    });
  });

  describe("multiple matches", () => {
    it("replaces all matches preserving correct positions (right-to-left)", async () => {
      const text = "a@b.com and c@d.com";
      const matches = [
        makeMatch("email", "a@b.com", 0),
        makeMatch("email", "c@d.com", 12),
      ];
      const result = await replacePii(text, matches, "placeholder");
      expect(result).toBe("[EMAIL_REDACTED] and [EMAIL_REDACTED]");
    });
  });
});
