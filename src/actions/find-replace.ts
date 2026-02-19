import type { FindReplaceAction, RequestContext, ActionResult } from "../types";

export function executeFindReplace(
  ctx: RequestContext,
  action: FindReplaceAction,
): ActionResult {
  let pattern: string | RegExp;

  if (action.is_regex) {
    const flags = action.case_sensitive ? "g" : "gi";
    try {
      pattern = new RegExp(action.find, flags);
    } catch {
      console.error(`Invalid regex in find_replace action: ${action.find}`);
      return {};
    }
  } else {
    // Literal string replacement — use regex for global replace
    const escaped = action.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = action.case_sensitive ? "g" : "gi";
    pattern = new RegExp(escaped, flags);
  }

  ctx.body = ctx.body.replace(pattern, action.replace);

  // Re-parse body if it was JSON
  try {
    ctx.parsedBody = JSON.parse(ctx.body);
  } catch {
    // Not valid JSON after replacement
  }

  return {};
}
