// --- Mirrored from app/lib/types.ts ---

export type PiiCategory =
  | "email"
  | "phone"
  | "ssn"
  | "credit_card"
  | "ip_address"
  | "address"
  | "name"
  | "date_of_birth";

export type AiPiiCategory =
  | "person"
  | "location"
  | "organization";

export type ToxicityCategory = "toxic" | "severe_toxic" | "obscene" | "threat" | "insult" | "identity_hate";
export type DlpCategory = "source_code" | "credentials" | "internal_document" | "financial_data";
export type ComplianceDomain = "healthcare" | "financial" | "legal" | "insurance";

type ActionBase = {
  id: string;
  enabled: boolean;
};

export type RedactPiiAction = ActionBase & {
  type: "redact_pii";
  categories: PiiCategory[];
  replacement: "placeholder" | "hash" | "mask";
  mode: "redact" | "mask_and_restore";
  token_prefix: string;
  ttl_seconds: number;
};

export type FindReplaceAction = ActionBase & {
  type: "find_replace";
  find: string;
  replace: string;
  is_regex: boolean;
  case_sensitive: boolean;
  mode?: "redact" | "mask_and_restore";
  token_prefix?: string;
  ttl_seconds?: number;
};

export type TokenizeAction = ActionBase & {
  type: "tokenize";
  fields: string[];
  token_prefix: string;
  ttl_seconds: number;
};

export type RedactFieldAction = ActionBase & {
  type: "redact_field";
  fields: string[];
  replacement: string;
};

export type BlockRequestAction = ActionBase & {
  type: "block_request";
  status_code: number;
  message: string;
};

export type LogOnlyAction = ActionBase & {
  type: "log_only";
  severity: "info" | "warn" | "critical";
  label: string;
};

export type RestrictToolsAction = ActionBase & {
  type: "restrict_tools";
  // Tool names the agent is permitted to call. Anything not listed is disallowed.
  allowed_tools: string[];
  // Which enforcement points are active for this policy.
  enforce: { request: boolean; response: boolean };
  // What to do when a disallowed tool call appears in the response (buffered only).
  on_violation: "block" | "strip";
  block_status_code: number;
  block_message: string;
};

export type RouteModelAction = ActionBase & {
  type: "route_model";
  // Model to send upstream instead of the requested one. Must be served by the
  // same provider as the original request — the provider key chain is resolved
  // from the target URL before rules run.
  target_model: string;
  // "always": every matching request. "budget_over_pct": only once the most
  // constrained matching budget has spent at least `budget_pct` of its limit.
  when: "always" | "budget_over_pct";
  budget_pct: number;
};

export type AiDetectPiiAction = ActionBase & {
  type: "ai_detect_pii";
  categories: AiPiiCategory[];
  replacement: "placeholder" | "hash" | "mask";
  mode: "redact" | "mask_and_restore";
  token_prefix: string;
  ttl_seconds: number;
};

export type AiDetectInjectionAction = ActionBase & {
  type: "ai_detect_injection";
  threshold: number; // 0-1, block if score >= threshold
  on_detect: "block" | "log";
  block_status_code: number;
  block_message: string;
};

export type AiDetectToxicityAction = ActionBase & {
  type: "ai_detect_toxicity";
  categories: ToxicityCategory[];
  threshold: number;
  on_detect: "block" | "log" | "redact";
  block_status_code: number;
  block_message: string;
};

export type AiDetectDlpAction = ActionBase & {
  type: "ai_detect_dlp";
  categories: DlpCategory[];
  threshold: number;
  on_detect: "block" | "log";
  block_status_code: number;
  block_message: string;
};

export type AiDetectComplianceAction = ActionBase & {
  type: "ai_detect_compliance";
  domains: ComplianceDomain[];
  threshold: number;
  on_detect: "block" | "log" | "flag";
  block_status_code: number;
  block_message: string;
};

export type RuleAction =
  | RedactPiiAction
  | FindReplaceAction
  | TokenizeAction
  | RedactFieldAction
  | BlockRequestAction
  | LogOnlyAction
  | AiDetectPiiAction
  | AiDetectInjectionAction
  | AiDetectToxicityAction
  | AiDetectDlpAction
  | AiDetectComplianceAction
  | RestrictToolsAction
  | RouteModelAction;

export type RuleCondition = {
  id: string;
  field: "header" | "model" | "body" | "url";
  operator: "contains" | "equals" | "matches" | "exists";
  value: string;
};

export type RuleConditionGroup = {
  id: string;
  logic: "and" | "or";
  conditions: RuleCondition[];
};

export type Rule = {
  id: string;
  user_id: string;
  team_id: string;
  name: string;
  description: string;
  enabled: boolean;
  apply_to: "input" | "output" | "both";
  sampling_rate: number;
  timeout_seconds: number;
  conditions: RuleConditionGroup[];
  match_all: boolean;
  actions: RuleAction[];
  created_at: string;
  updated_at: string;
};

export type TrafficLogEntry = {
  id?: string;
  user_id: string;
  team_id: string;
  api_key_id?: string | null;
  method: string;
  target_url: string;
  status_code: number;
  rules_applied: string[];
  duration_ms: number;
  request_headers: Record<string, string>;
  request_body: string;
  response_headers: Record<string, string>;
  response_body: string;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  model?: string | null;
  provider?: string | null;
  /** Model the caller asked for when a route_model action swapped it. */
  requested_model?: string | null;
  original_request_body?: string | null;
  request_body_r2_key?: string | null;
  response_body_r2_key?: string | null;
  original_request_body_r2_key?: string | null;
  trace_id?: string | null;
  parent_span_id?: string | null;
  label?: string | null;
  metadata?: Record<string, string> | null;
  seq?: number | null;
  session_id?: string | null;
  prompt_id?: string | null;
  prompt_version?: number | null;
  provider_key_id?: string | null;
  source?: "proxy" | "trace";
  created_at?: string;
};

// Row inserted into `tool_calls` when the proxy sees an assistant response
// emit a tool_use block. `status` starts as 'pending' and is updated by
// link_tool_call_results when the matching tool_result arrives.
export type ToolCallInsertRow = {
  id?: string;
  team_id: string;
  user_id: string;
  traffic_log_id: string;
  session_id: string | null;
  trace_id: string | null;
  provider_tool_call_id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  arguments_hash: string;
  status: "pending";
  model: string | null;
  provider: string | null;
};

// One link entry passed to link_tool_call_results.
export type ToolCallLink = {
  provider_tool_call_id: string;
  result: unknown;
  is_error: boolean;
  result_traffic_log_id: string;
};

export type EmbeddingLogEntry = {
  id?: string;
  team_id: string;
  trace_id?: string | null;
  provider_key_id?: string | null;
  byok: boolean;
  model: string;
  input_count: number;
  total_chars: number;
  dimensions?: number | null;
  redaction_strategy: "placeholder" | "hash" | "mask";
  redaction_categories: string[];
  redaction_count: number;
  redaction_source?: "regex" | "ai" | "both" | null;
  blocked: boolean;
  status_code: number;
  tokens?: number | null;
  duration_ms: number;
};

export type ApiSettings = {
  id: string;
  user_id: string;
  team_id: string;
  api_key: string;
  fallback_mode: "passthrough" | "error";
  zero_data_mode: boolean;
  created_at: string;
  updated_at: string;
};

// --- Prompt types ---

export type PromptMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type PromptVariable = {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  default?: string;
};

export type PromptRecord = {
  id: string;
  team_id: string;
  slug: string;
  name: string;
  skip_rules: boolean;
  active_version: number | null;
};

export type PromptVersionRecord = {
  id: string;
  prompt_id: string;
  version: number | null;
  messages: PromptMessage[];
  variables: PromptVariable[] | null;
  published_at: string | null;
};

// --- Proxy-specific types ---

export type AuthInfo = {
  team_id: string;
  user_id: string;
  api_settings_id: string;
  fallback_mode: "passthrough" | "error";
  zero_data_mode: boolean;
  tier: string;
};

export type RequestContext = {
  requestId: string;
  auth: AuthInfo;
  method: string;
  targetUrl: string;
  headers: Record<string, string>;
  body: string;
  parsedBody: unknown;
  startedAt: number;
  traceId: string | null;
  /** Caller's span id from an incoming W3C traceparent header (only set when
   * traceId also came from traceparent). */
  parentSpanId: string | null;
  label: string | null;
  metadata: Record<string, string> | null;
  seq: number | null;
  sessionId: string | null;
  /** Highest spend ratio (0-100+) across budgets matching this request, or
   * null when no budget matches. Consumed by route_model. */
  budgetSpendPct: number | null;
  /** Original model when a route_model action rewrote it. */
  routedFrom: string | null;
  /** Which pipeline pass this context represents. Unset/"input" = request pass;
   * "output" = response pass (set by the handler on the response-oriented context).
   * Lets a single action behave differently per direction. */
  phase?: "input" | "output";
  /** When set, redaction actions push per-match details here for the debug pipeline view. */
  debugTrace?: DebugTrace | null;
};

/**
 * Per-request capture of every pipeline stage for the debug demo view.
 * Only populated when the caller opts in via X-Grepture-Debug header AND
 * the team is not in zero_data_mode. Persisted to `debug_traces` with a
 * 24h TTL, never to `traffic_logs`.
 */
export type DebugRedactionEntry = {
  source: "redact_pii" | "ai_detect_pii" | "tokenize" | "find_replace";
  category?: string;
  field?: string;
  original: string;
  replacement: string;
  mode: "redact" | "mask_and_restore";
};

export type DebugTrace = {
  // Stage 1: exactly what the caller sent.
  input_raw: string;
  // Stage 2: every redaction/token replacement performed on the input.
  redactions: DebugRedactionEntry[];
  // Stage 3: what we actually forwarded upstream (post-redaction body).
  upstream_request_body: string;
  upstream_target_url: string;
  // Stage 4: raw upstream response (pre-detokenize, pre-output-rules).
  upstream_response_body: string;
  upstream_status: number;
  // Stage 5: final body returned to the caller (post-detokenize).
  output_final: string;
  // Timing per stage, useful in the demo view.
  timings_ms: {
    upstream?: number;
    total?: number;
  };
  rules_applied: string[];
};

export type ActionResult = {
  blocked?: boolean;
  statusCode?: number;
  message?: string;
  tags?: Array<{ severity: string; label: string }>;
};

export type ProxyResult = {
  response: Response;
  rulesApplied: string[];
  tags: Array<{ severity: string; label: string }>;
};
