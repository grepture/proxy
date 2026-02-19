import type { TokenVault, QuotaChecker } from "../providers/types";
import type { Rule, RuleAction, RequestContext, ActionResult } from "../types";
import { getAction } from "./registry";

const AI_ACTION_TYPES = ["ai_detect_pii", "ai_detect_injection", "ai_detect_toxicity", "ai_detect_dlp", "ai_detect_compliance"];
const BUSINESS_AI_ACTIONS = ["ai_detect_injection", "ai_detect_toxicity", "ai_detect_dlp", "ai_detect_compliance"];

export type PipelineResult = {
  blocked: boolean;
  statusCode?: number;
  message?: string;
  rulesApplied: string[];
  tags: Array<{ severity: string; label: string }>;
  aiSampling?: { used: number; limit: number };
};

async function executeAction(
  ctx: RequestContext,
  action: RuleAction,
  vault: TokenVault,
): Promise<ActionResult> {
  const plugin = getAction(action.type);
  if (!plugin) {
    // Unknown action type — silently skip (e.g. AI actions when plugin not loaded)
    return {};
  }
  return plugin.execute(ctx, action, vault);
}

export async function runPipeline(
  ctx: RequestContext,
  matchedRules: Rule[],
  vault: TokenVault,
  quota?: QuotaChecker,
): Promise<PipelineResult> {
  const rulesApplied: string[] = [];
  const tags: Array<{ severity: string; label: string }> = [];
  let aiSampling: { used: number; limit: number } | undefined;

  for (const rule of matchedRules) {
    for (const action of rule.actions) {
      if (!action.enabled) continue;

      // Tier-gate AI actions at runtime
      if (AI_ACTION_TYPES.includes(action.type)) {
        if (ctx.auth.tier === "free") {
          if (quota) {
            const sampling = await quota.checkAiSampling(ctx.auth.team_id, ctx.auth.tier);
            aiSampling = { used: sampling.used, limit: sampling.limit };
            if (!sampling.allowed) continue;
          }
        } else if (ctx.auth.tier === "pro" && BUSINESS_AI_ACTIONS.includes(action.type)) {
          continue;
        }
      }

      const result = await executeAction(ctx, action, vault);

      // Collect tags
      if (result.tags) tags.push(...result.tags);

      // Block short-circuit
      if (result.blocked) {
        rulesApplied.push(rule.id);
        return {
          blocked: true,
          statusCode: result.statusCode,
          message: result.message,
          rulesApplied,
          tags,
          aiSampling,
        };
      }
    }

    rulesApplied.push(rule.id);
  }

  return { blocked: false, rulesApplied, tags, aiSampling };
}
