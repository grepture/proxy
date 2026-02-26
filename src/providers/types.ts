import type { AuthInfo, Rule, TrafficLogEntry, RuleAction, RequestContext, ActionResult } from "../types";

export interface ActionPlugin {
  type: string;
  execute(ctx: RequestContext, action: RuleAction, vault: TokenVault): Promise<ActionResult>;
  /** Stateless scan — used by /v1/scan and /v1/scan-files endpoints */
  scan?(text: string): Promise<unknown>;
}

export interface AuthProvider {
  authenticate(apiKey: string): Promise<AuthInfo | null>;
}

export interface RuleProvider {
  loadRules(teamId: string): Promise<Rule[]>;
}

export interface LogWriter {
  push(entry: TrafficLogEntry): void;
  flush(): Promise<void>;
}

export interface TokenVault {
  set(teamId: string, token: string, value: string, ttl: number): Promise<void>;
  get(teamId: string, token: string): Promise<string | null>;
}

export interface RateLimiter {
  check(teamId: string, tier: string): Promise<{ allowed: boolean; retryAfter?: number; limit?: number }>;
}

export interface QuotaChecker {
  check(teamId: string, tier: string): Promise<{ allowed: boolean }>;
  checkAiSampling(teamId: string, tier: string): Promise<{ allowed: boolean; used: number; limit: number }>;
}

export interface RateQuotaChecker {
  check(teamId: string, tier: string): Promise<{
    rate: { allowed: boolean; retryAfter?: number; limit?: number };
    quota: { allowed: boolean };
  }>;
  checkAiSampling(teamId: string, tier: string): Promise<{ allowed: boolean; used: number; limit: number }>;
}
