import type { RedactFieldAction, RequestContext, ActionResult } from "../types";

function setByPath(obj: unknown, path: string, value: unknown): void {
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

function getByPath(obj: unknown, path: string): unknown {
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
