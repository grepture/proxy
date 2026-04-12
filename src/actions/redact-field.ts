import type { RedactFieldAction, RequestContext, ActionResult } from "../types";
import { getByPath, setByPath } from "./tokenize";

export function executeRedactField(
  ctx: RequestContext,
  action: RedactFieldAction,
): ActionResult {
  if (!ctx.parsedBody || typeof ctx.parsedBody !== "object") return {};

  for (const field of action.fields) {
    const existing = getByPath(ctx.parsedBody, field);
    if (existing === undefined) continue;
    setByPath(ctx.parsedBody, field, action.replacement);
  }

  // Re-serialize body
  ctx.body = JSON.stringify(ctx.parsedBody);

  return {};
}
