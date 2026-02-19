import type { TokenVault } from "../providers/types";
import { detectPii } from "../pii/detector";
import { replacePii } from "../pii/replacer";
import type { RedactPiiAction, RequestContext, ActionResult } from "../types";

export async function executeRedactPii(
  ctx: RequestContext,
  action: RedactPiiAction,
  vault: TokenVault,
): Promise<ActionResult> {
  const matches = detectPii(ctx.body, action.categories);
  if (matches.length === 0) return {};

  if (action.mode === "mask_and_restore") {
    // Generate tokens for each PII match and store originals in vault
    const prefix = action.token_prefix || "pii_";
    const ttl = action.ttl_seconds || 3600;

    // Replace right-to-left to preserve indices
    let result = ctx.body;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      const token = `${prefix}${crypto.randomUUID()}`;
      await vault.set(ctx.auth.team_id, token, m.match, ttl);
      result = result.slice(0, m.start) + token + result.slice(m.end);
    }

    ctx.body = result;
  } else {
    // Permanent redaction (existing behavior)
    ctx.body = await replacePii(ctx.body, matches, action.replacement);
  }

  // Re-parse body if it was JSON
  try {
    ctx.parsedBody = JSON.parse(ctx.body);
  } catch {
    // Not valid JSON after replacement — that's fine
  }

  return {};
}
