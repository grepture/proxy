import type { AuthInfo, Rule, TrafficLogEntry, EmbeddingLogEntry, RuleAction, RequestContext, ActionResult, ToolCallInsertRow, ToolCallLink, DebugTrace } from "../types";

/** A row destined for debug_traces. Bodies may be large; the writer offloads to R2 if available. */
export type DebugTraceEntry = {
  id?: string;
  team_id: string;
  user_id: string;
  traffic_log_id: string;
  stages: DebugTrace;
};

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
  pushEmbedding(entry: EmbeddingLogEntry): void;
  pushDebugTrace(entry: DebugTraceEntry): void;
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

/** A budget rule from the team's definitions cache. */
export interface BudgetDef {
  id: string;
  scope_type: "api_key" | "label";
  api_settings_id: string | null;
  scope_value: string | null;
  period: "daily" | "monthly";
  limit_cents: number;
}

/** A matching budget for the current request, with current spent micro-cents. */
export interface BudgetMatch {
  def: BudgetDef;
  period_key: string;
  spent_micro_cents: number;
}

export interface BudgetChecker {
  /**
   * Return budgets active for this team that match the (apiSettingsId, label) tuple.
   * Caller decides whether to reject based on `spent_micro_cents` vs the limit.
   */
  match(teamId: string, apiSettingsId: string, label: string | null): Promise<BudgetMatch[]>;

  /** Increment each matching budget's `:spent:` counter by `cost_micro_cents`. */
  recordSpend(matches: BudgetMatch[], cost_micro_cents: number): Promise<void>;
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
