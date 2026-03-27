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
  | AiDetectComplianceAction;

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
  model?: string | null;
  provider?: string | null;
  original_request_body?: string | null;
  trace_id?: string | null;
  label?: string | null;
  session_id?: string | null;
  prompt_id?: string | null;
  prompt_version?: number | null;
  source?: "proxy" | "trace";
  created_at?: string;
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
  label: string | null;
  sessionId: string | null;
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
