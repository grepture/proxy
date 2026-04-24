import type { AuthInfo, Rule, TrafficLogEntry, RuleAction, RequestContext, ActionResult, ToolCallInsertRow, ToolCallLink } from "../types";

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

export interface ToolCallWriter {
  /** Enqueue a new tool_calls row to insert. */
  pushInsert(row: ToolCallInsertRow): void;
  /** Enqueue a link update for a tool_result received in a follow-up request.
   * team_id is carried here (rather than on every link entry) because the
   * link RPC scopes updates per team. */
  pushLink(teamId: string, link: ToolCallLink): void;
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

/** A provider key after decryption — plaintext only lives in process memory. */
export interface ResolvedProviderKey {
  id: string;
  provider: string;
  decrypted: string;
  default_model: string | null;
  fallback_key_id: string | null;
}

export interface ProviderKeyResolver {
  /** Resolve a team's primary key for a given provider. */
  resolve(teamId: string, provider: string): Promise<ResolvedProviderKey | null>;
  /** Resolve a key by its ID — used to follow the fallback chain. */
  resolveById(keyId: string): Promise<ResolvedProviderKey | null>;
  /**
   * Resolve the full fallback chain starting from the team's primary key for a provider.
   * Returns the chain in order [primary, fallback1, fallback2, ...]. Stops at maxHops.
   */
  resolveChain(teamId: string, provider: string, maxHops?: number): Promise<ResolvedProviderKey[]>;
}
