import { readFileSync, watchFile } from "fs";
import type { RuleProvider } from "../types";
import type { Rule } from "../../types";

export class LocalRuleProvider implements RuleProvider {
  private rules: Rule[] = [];
  private rulesPath: string;

  constructor() {
    this.rulesPath = process.env.GREPTURE_RULES_FILE || "rules.json";
    this.load();

    // Reload on SIGHUP
    process.on("SIGHUP", () => {
      console.log("SIGHUP received, reloading rules...");
      this.load();
    });

    // Watch file for changes
    try {
      watchFile(this.rulesPath, { interval: 5000 }, () => {
        console.log("Rules file changed, reloading...");
        this.load();
      });
    } catch {
      // File watch not supported or file doesn't exist yet
    }
  }

  private load(): void {
    try {
      const raw = readFileSync(this.rulesPath, "utf-8");
      const parsed = JSON.parse(raw);
      this.rules = (Array.isArray(parsed) ? parsed : []) as Rule[];
      console.log(`Loaded ${this.rules.length} rules from ${this.rulesPath}`);
    } catch (err) {
      if (this.rules.length === 0) {
        console.warn(`No rules file found at ${this.rulesPath} (starting with empty rules)`);
      } else {
        console.error(`Failed to reload rules from ${this.rulesPath}:`, err);
      }
    }
  }

  async loadRules(_teamId: string): Promise<Rule[]> {
    return this.rules.filter((r) => r.enabled);
  }
}
