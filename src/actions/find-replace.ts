import type { TokenVault } from "../providers/types";
import { transformStrings, type StringTransform } from "./transform-strings";
import type { FindReplaceAction, RequestContext, ActionResult } from "../types";

export async function executeFindReplace(
  ctx: RequestContext,
  action: FindReplaceAction,
  vault: TokenVault,
): Promise<ActionResult> {
  let pattern: RegExp;

  if (action.is_regex) {
    // JS has no leading inline-flag syntax; patterns copied from PCRE/Go
    // libraries often start with (?i), so translate it to the `i` flag.
    const inlineInsensitive = action.find.startsWith("(?i)");
    const source = inlineInsensitive ? action.find.slice(4) : action.find;
    const flags = action.case_sensitive && !inlineInsensitive ? "g" : "gi";
    try {
      pattern = new RegExp(source, flags);
    } catch {
      console.error(`Invalid regex in find_replace action: ${action.find}`);
      return {};
    }
  } else {
    const escaped = action.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const flags = action.case_sensitive ? "g" : "gi";
    pattern = new RegExp(escaped, flags);
  }

  const isMask = action.mode === "mask_and_restore";
  const prefix = action.token_prefix || "tok_";
  const ttl = action.ttl_seconds || 3600;

  const maskString: StringTransform = async (s) => {
    const matches = [...s.matchAll(pattern)];
    if (matches.length === 0) return s;
    let result = s;
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      if (m.index === undefined) continue;
      const token = `${prefix}${crypto.randomUUID()}`;
      await vault.set(ctx.auth.team_id, token, m[0], ttl);
      result = result.slice(0, m.index) + token + result.slice(m.index + m[0].length);
      if (ctx.debugTrace) {
        ctx.debugTrace.redactions.push({
          source: "find_replace",
          original: m[0],
          replacement: token,
          mode: "mask_and_restore",
        });
      }
    }
    return result;
  };

  const replaceString: StringTransform = async (s) => {
    if (!ctx.debugTrace) return s.replace(pattern, action.replace);
    const matches = [...s.matchAll(pattern)];
    for (const m of matches) {
      ctx.debugTrace.redactions.push({
        source: "find_replace",
        original: m[0],
        replacement: action.replace,
        mode: "redact",
      });
    }
    return s.replace(pattern, action.replace);
  };
  const transform = isMask ? maskString : replaceString;

  // Prefer walking decoded string values: regex authors think in terms of the
  // text they see in messages, not the JSON-escaped bytes (e.g. `\b` against a
  // value preceded by an encoded `\n` finds no boundary). Walking also keeps
  // structural keys safe from accidental replacement.
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    parsed = undefined;
  }

  if (parsed !== undefined && parsed !== null && typeof parsed === "object") {
    const transformed = await transformStrings(parsed, transform);
    ctx.body = JSON.stringify(transformed);
    ctx.parsedBody = transformed;
  } else {
    // Non-JSON body: fall back to raw-string replacement.
    ctx.body = await transform(ctx.body);
  }

  return {};
}
