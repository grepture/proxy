import type { TokenVault } from "../providers/types";
import type { TokenizeAction, RequestContext, ActionResult } from "../types";

/** Simple dot-notation JSON path walker. Handles `user.email`, `items[0].name`, strips `$.` prefix. */
export function getByPath(obj: unknown, path: string): unknown {
  const cleaned = path.startsWith("$.") ? path.slice(2) : path;
  const segments = cleaned.split(/\.|\[(\d+)\]/).filter(Boolean);

  let current: unknown = obj;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof current === "object") {
      current = (current as Record<string, unknown>)[seg];
    } else {
      return undefined;
    }
  }
  return current;
}

export function setByPath(obj: unknown, path: string, value: unknown): void {
  const cleaned = path.startsWith("$.") ? path.slice(2) : path;
  const segments = cleaned.split(/\.|\[(\d+)\]/).filter(Boolean);

  let current: unknown = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    if (current === null || current === undefined || typeof current !== "object") return;
    current = (current as Record<string, unknown>)[segments[i]];
  }
  if (current !== null && current !== undefined && typeof current === "object") {
    (current as Record<string, unknown>)[segments[segments.length - 1]] = value;
  }
}

export async function executeTokenize(
  ctx: RequestContext,
  action: TokenizeAction,
  vault: TokenVault,
): Promise<ActionResult> {
  if (!ctx.parsedBody || typeof ctx.parsedBody !== "object") return {};

  for (const field of action.fields) {
    const original = getByPath(ctx.parsedBody, field);
    if (original === undefined || original === null) continue;

    const originalStr = typeof original === "string" ? original : JSON.stringify(original);
    const token = `${action.token_prefix}${crypto.randomUUID()}`;

    // Store in vault
    await vault.set(ctx.auth.team_id, token, originalStr, action.ttl_seconds);

    // Replace in parsed body
    setByPath(ctx.parsedBody, field, token);
  }

  // Re-serialize body
  ctx.body = JSON.stringify(ctx.parsedBody);

  return {};
}

/** Detokenize: scan text for tokens matching prefix, look up in vault, replace with originals. */
export async function detokenize(
  text: string,
  teamId: string,
  tokenPrefixes: string[],
  vault: TokenVault,
): Promise<string> {
  if (tokenPrefixes.length === 0) return text;

  // Build regex to find tokens: prefix followed by UUID
  const uuidPattern = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const prefixPattern = tokenPrefixes.map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const regex = new RegExp(`(?:${prefixPattern})${uuidPattern}`, "g");

  const tokens = text.match(regex);
  if (!tokens) return text;

  // Dedupe
  const unique = [...new Set(tokens)];

  // Look up all tokens
  let result = text;
  for (const token of unique) {
    const original = await vault.get(teamId, token);
    const replacement = original ?? "[TOKEN_EXPIRED]";
    result = result.replaceAll(token, replacement);
  }

  return result;
}
