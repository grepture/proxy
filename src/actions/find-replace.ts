import type { TokenVault } from "../providers/types";
import type { FindReplaceAction, RequestContext, ActionResult } from "../types";

export async function executeFindReplace(
  ctx: RequestContext,
  action: FindReplaceAction,
  vault: TokenVault,
): Promise<ActionResult> {
  let pattern: RegExp;

  if (action.is_regex) {
    const flags = action.case_sensitive ? "g" : "gi";
    try {
      pattern = new RegExp(action.find, flags);
    } catch {
      console.error(`Invalid regex in find_replace action: ${action.find}`);
      return {};
    }
  } else {
    const escaped = action.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = action.case_sensitive ? "g" : "gi";
    pattern = new RegExp(escaped, flags);
  }

  const reversible = action.mode === "mask_and_restore";

  // Defensive tier gate: mask_and_restore is Pro+ only. A stale rule from a
  // downgraded team falls back to one-way redaction rather than silently
  // storing tokens for a free team.
  if (reversible && ctx.auth.tier === "free") {
    console.warn(
      `find_replace mask_and_restore attempted on free tier (team ${ctx.auth.team_id}); falling back to one-way redaction`,
    );
    ctx.body = ctx.body.replace(pattern, action.replace);
  } else if (reversible) {
    const prefix = action.token_prefix || "tok_";
    const ttl = action.ttl_seconds || 3600;

    const matches: { start: number; end: number; value: string }[] = [];
    for (const m of ctx.body.matchAll(pattern)) {
      if (m.index === undefined) continue;
      matches.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }

    let result = ctx.body;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const token = `${prefix}${crypto.randomUUID()}`;
      await vault.set(ctx.auth.team_id, token, m.value, ttl);
      result = result.slice(0, m.start) + token + result.slice(m.end);
    }
    ctx.body = result;
  } else {
    ctx.body = ctx.body.replace(pattern, action.replace);
  }

  try {
    ctx.parsedBody = JSON.parse(ctx.body);
  } catch {
    // Not valid JSON after replacement
  }

  return {};
}
