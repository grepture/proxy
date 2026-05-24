import type { TokenVault } from "../providers/types";
import type { FindReplaceAction, RequestContext, ActionResult } from "../types";

type StringTransform = (s: string) => Promise<string>;

async function transformStrings(value: unknown, transform: StringTransform): Promise<unknown> {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = await transformStrings(value[i], transform);
    }
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = await transformStrings(v, transform);
    }
    return out;
  }
  return value;
}

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
