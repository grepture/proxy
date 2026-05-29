import type { TokenVault } from "../providers/types";
import { detectPii } from "../pii/detector";
import { placeholders, replacePii } from "../pii/replacer";
import type { RedactPiiAction, RequestContext, ActionResult } from "../types";

function debugReplacementLabel(
  category: keyof typeof placeholders,
  strategy: "placeholder" | "hash" | "mask",
  original: string,
): string {
  if (strategy === "placeholder") return placeholders[category] || "[REDACTED]";
  if (strategy === "mask") {
    if (original.length <= 2) return "**";
    if (original.length <= 4) return original[0] + "***";
    return original[0] + "*".repeat(original.length - 2) + original[original.length - 1];
  }
  return "[HASHED]";
}

type StringTransform = (s: string) => Promise<string>;

/** Walk only the string leaves of a parsed JSON value, applying `transform`. */
async function transformStrings(value: unknown, transform: StringTransform): Promise<unknown> {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = await transformStrings(value[i], transform);
    return out;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = await transformStrings(v, transform);
    return out;
  }
  return value;
}

export async function executeRedactPii(
  ctx: RequestContext,
  action: RedactPiiAction,
  vault: TokenVault,
): Promise<ActionResult> {
  const isMask = action.mode === "mask_and_restore";
  const prefix = action.token_prefix || "pii_";
  const ttl = action.ttl_seconds || 3600;

  // Redact PII within a single decoded string. Indices from detectPii refer to
  // this string, so replacement stays inside the value and can't break JSON.
  const redactString: StringTransform = async (s) => {
    const matches = detectPii(s, action.categories);
    if (matches.length === 0) return s;

    if (isMask) {
      // Replace right-to-left to preserve indices; store originals in the vault.
      let result = s;
      for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        const token = `${prefix}${crypto.randomUUID()}`;
        await vault.set(ctx.auth.team_id, token, m.match, ttl);
        result = result.slice(0, m.start) + token + result.slice(m.end);
        if (ctx.debugTrace) {
          ctx.debugTrace.redactions.push({
            source: "redact_pii",
            category: m.category,
            original: m.match,
            replacement: token,
            mode: "mask_and_restore",
          });
        }
      }
      return result;
    }

    if (ctx.debugTrace) {
      for (const m of matches) {
        ctx.debugTrace.redactions.push({
          source: "redact_pii",
          category: m.category,
          original: m.match,
          replacement: debugReplacementLabel(m.category, action.replacement, m.match),
          mode: "redact",
        });
      }
    }
    return replacePii(s, matches, action.replacement);
  };

  // Prefer walking decoded JSON string values: this keeps matches from landing
  // on structural tokens (numbers like `created`, keys, punctuation) and
  // corrupting the document. Mirrors find_replace / tokenize. Falls back to
  // whole-body redaction for non-JSON payloads.
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    parsed = undefined;
  }

  if (parsed !== null && typeof parsed === "object") {
    const transformed = await transformStrings(parsed, redactString);
    ctx.body = JSON.stringify(transformed);
    ctx.parsedBody = transformed;
    return {};
  }

  // Non-JSON body: redact the raw text.
  ctx.body = await redactString(ctx.body);
  try {
    ctx.parsedBody = JSON.parse(ctx.body);
  } catch {
    // Not valid JSON after replacement — that's fine.
  }

  return {};
}
