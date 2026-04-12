import type { Rule, RuleAction, RuleConditionGroup } from "../../src/types";

let ruleCounter = 0;

/** Factory for minimal rule objects. Override any field via the partial. */
export function makeRule(overrides: Partial<Rule> = {}): Rule {
  ruleCounter++;
  return {
    id: `rule-${ruleCounter}`,
    user_id: "test-user",
    team_id: "test-team",
    name: `Test Rule ${ruleCounter}`,
    description: "",
    enabled: true,
    apply_to: "both",
    sampling_rate: 100,
    timeout_seconds: 30,
    conditions: [],
    match_all: false,
    actions: [],
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

export function makeConditionGroup(
  overrides: Partial<RuleConditionGroup> = {},
): RuleConditionGroup {
  return {
    id: "group-1",
    logic: "and",
    conditions: [],
    ...overrides,
  };
}

/** Shorthand for a block action */
export function blockAction(
  statusCode = 403,
  message = "Blocked by rule",
): RuleAction {
  return {
    id: "action-block",
    enabled: true,
    type: "block_request",
    status_code: statusCode,
    message,
  } as RuleAction;
}

/** Shorthand for a log_only action */
export function logAction(
  label = "test-label",
  severity: "info" | "warn" | "critical" = "info",
): RuleAction {
  return {
    id: "action-log",
    enabled: true,
    type: "log_only",
    severity,
    label,
  } as RuleAction;
}

/** Shorthand for a find_replace action */
export function findReplaceAction(
  find: string,
  replace: string,
  opts: { is_regex?: boolean; case_sensitive?: boolean } = {},
): RuleAction {
  return {
    id: "action-fr",
    enabled: true,
    type: "find_replace",
    find,
    replace,
    is_regex: opts.is_regex ?? false,
    case_sensitive: opts.case_sensitive ?? true,
  } as RuleAction;
}

/** Shorthand for a redact_field action */
export function redactFieldAction(
  fields: string[],
  replacement = "[REDACTED]",
): RuleAction {
  return {
    id: "action-rf",
    enabled: true,
    type: "redact_field",
    fields,
    replacement,
  } as RuleAction;
}

/** Shorthand for a tokenize action */
export function tokenizeAction(
  fields: string[],
  prefix = "tok_",
  ttl = 3600,
): RuleAction {
  return {
    id: "action-tok",
    enabled: true,
    type: "tokenize",
    fields,
    token_prefix: prefix,
    ttl_seconds: ttl,
  } as RuleAction;
}

/** Shorthand for a redact_pii action */
export function redactPiiAction(
  mode: "redact" | "mask_and_restore" = "redact",
  replacement: "placeholder" | "hash" | "mask" = "placeholder",
): RuleAction {
  return {
    id: "action-pii",
    enabled: true,
    type: "redact_pii",
    categories: ["email", "phone", "ssn"],
    replacement,
    mode,
    token_prefix: "pii_",
    ttl_seconds: 3600,
  } as RuleAction;
}
