import type { RouteModelAction, RequestContext, ActionResult } from "../types";

/**
 * Swap the requested model for `target_model` before forwarding. Same-provider
 * only: the provider key chain was already resolved from the target URL, so a
 * cross-provider target would be sent with the wrong key.
 */
export async function executeRouteModel(
  ctx: RequestContext,
  action: RouteModelAction,
): Promise<ActionResult> {
  if (ctx.phase === "output") return {};
  if (!action.target_model) return {};

  if (action.when === "budget_over_pct") {
    if (ctx.budgetSpendPct === null || ctx.budgetSpendPct < action.budget_pct) return {};
  }

  const parsed = ctx.parsedBody;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const body = parsed as Record<string, unknown>;
  const current = body.model;
  if (typeof current !== "string" || current === action.target_model) return {};

  body.model = action.target_model;
  ctx.body = JSON.stringify(body);
  ctx.parsedBody = body;
  // First rewrite wins so a chain of route actions still reports the caller's model.
  ctx.routedFrom ??= current;
  return {};
}
