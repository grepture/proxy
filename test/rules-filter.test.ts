import { describe, it, expect } from "bun:test";
import { filterRules } from "../src/rules/filter";
import { makeRule } from "./fixtures/rules";

describe("filterRules", () => {
  describe("direction filtering", () => {
    it("includes input rules for input direction", () => {
      const rules = [makeRule({ apply_to: "input" })];
      expect(filterRules(rules, "input")).toHaveLength(1);
    });

    it("excludes input rules for output direction", () => {
      const rules = [makeRule({ apply_to: "input" })];
      expect(filterRules(rules, "output")).toHaveLength(0);
    });

    it("includes output rules for output direction", () => {
      const rules = [makeRule({ apply_to: "output" })];
      expect(filterRules(rules, "output")).toHaveLength(1);
    });

    it("excludes output rules for input direction", () => {
      const rules = [makeRule({ apply_to: "output" })];
      expect(filterRules(rules, "input")).toHaveLength(0);
    });

    it("includes 'both' rules for either direction", () => {
      const rules = [makeRule({ apply_to: "both" })];
      expect(filterRules(rules, "input")).toHaveLength(1);
      expect(filterRules(rules, "output")).toHaveLength(1);
    });
  });

  describe("sampling", () => {
    it("always includes rules with sampling_rate 100", () => {
      const rules = [makeRule({ sampling_rate: 100 })];
      for (let i = 0; i < 10; i++) {
        expect(filterRules(rules, "input")).toHaveLength(1);
      }
    });

    it("always excludes rules with sampling_rate 0", () => {
      const rules = [makeRule({ sampling_rate: 0 })];
      for (let i = 0; i < 10; i++) {
        expect(filterRules(rules, "input")).toHaveLength(0);
      }
    });

    it("sampling_rate 50 includes roughly half the time", () => {
      const rules = [makeRule({ sampling_rate: 50 })];
      let included = 0;
      const N = 1000;
      for (let i = 0; i < N; i++) {
        if (filterRules(rules, "input").length > 0) included++;
      }
      expect(included).toBeGreaterThan(N * 0.3);
      expect(included).toBeLessThan(N * 0.7);
    });
  });
});
