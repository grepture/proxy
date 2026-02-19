import type { Rule, RuleCondition, RuleConditionGroup, RequestContext } from "../types";

function extractFieldValue(ctx: RequestContext, condition: RuleCondition): string | null {
  switch (condition.field) {
    case "header": {
      // value format: "Header-Name: expected" — for 'exists', just check header presence
      const colonIdx = condition.value.indexOf(":");
      if (colonIdx === -1) {
        // Treat entire value as header name for 'exists' operator
        return ctx.headers[condition.value.toLowerCase()] ?? null;
      }
      const headerName = condition.value.slice(0, colonIdx).trim().toLowerCase();
      return ctx.headers[headerName] ?? null;
    }
    case "model": {
      if (ctx.parsedBody && typeof ctx.parsedBody === "object" && "model" in ctx.parsedBody) {
        return String((ctx.parsedBody as Record<string, unknown>).model);
      }
      return null;
    }
    case "body":
      return ctx.body;
    case "url":
      return ctx.targetUrl;
    default:
      return null;
  }
}

function getExpectedValue(condition: RuleCondition): string {
  if (condition.field === "header") {
    const colonIdx = condition.value.indexOf(":");
    if (colonIdx === -1) return condition.value;
    return condition.value.slice(colonIdx + 1).trim();
  }
  return condition.value;
}

function evaluateCondition(ctx: RequestContext, condition: RuleCondition): boolean {
  const fieldValue = extractFieldValue(ctx, condition);
  const expected = getExpectedValue(condition);

  switch (condition.operator) {
    case "exists":
      return fieldValue !== null && fieldValue !== "";
    case "contains":
      return fieldValue !== null && fieldValue.toLowerCase().includes(expected.toLowerCase());
    case "equals":
      return fieldValue === expected;
    case "matches": {
      if (fieldValue === null) return false;
      try {
        return new RegExp(expected).test(fieldValue);
      } catch {
        return false;
      }
    }
    default:
      return false;
  }
}

function evaluateGroup(ctx: RequestContext, group: RuleConditionGroup): boolean {
  if (group.conditions.length === 0) return true;

  if (group.logic === "and") {
    return group.conditions.every((c) => evaluateCondition(ctx, c));
  }
  // "or"
  return group.conditions.some((c) => evaluateCondition(ctx, c));
}

export function matchRule(ctx: RequestContext, rule: Rule): boolean {
  // match_all means auto-match
  if (rule.match_all) return true;

  // No condition groups means no match
  if (rule.conditions.length === 0) return false;

  // Groups are OR'd: any group matching means rule matches
  return rule.conditions.some((group) => evaluateGroup(ctx, group));
}

export function matchRules(ctx: RequestContext, rules: Rule[]): Rule[] {
  return rules.filter((rule) => matchRule(ctx, rule));
}
