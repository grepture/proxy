import type { RestrictToolsAction, RequestContext, ActionResult } from "../types";
import { extractToolUses } from "../translation/response";

type AnyRecord = Record<string, unknown>;

/**
 * Resolve the callable name of a tool *definition* across provider shapes:
 *   - OpenAI Chat Completions: { type: "function", function: { name } }
 *   - Anthropic Messages:      { name, input_schema }
 *   - OpenAI Responses (function tool): { type: "function", name }
 * Returns null for unnamed / built-in tools (e.g. { type: "web_search" }),
 * which are not subject to the allowlist and pass through untouched.
 */
function toolDefName(tool: AnyRecord): string | null {
  const fn = tool.function as AnyRecord | undefined;
  if (fn && typeof fn.name === "string") return fn.name;
  if (typeof tool.name === "string") return tool.name;
  return null;
}

function isAllowedDef(name: string | null, allowed: Set<string>): boolean {
  // Unnamed/built-in tools are not gated by the allowlist.
  return name === null || allowed.has(name);
}

/**
 * Strip disallowed tool *definitions* from an outgoing request body so the
 * model never sees them. Also neutralizes a forced `tool_choice` /
 * `function_call` that names a now-stripped tool. Mutates `parsed` in place;
 * returns true when anything changed.
 */
function stripRequestTools(parsed: AnyRecord, allowed: Set<string>): boolean {
  let changed = false;

  if (Array.isArray(parsed.tools)) {
    const before = (parsed.tools as unknown[]).length;
    parsed.tools = (parsed.tools as AnyRecord[]).filter((t) => isAllowedDef(toolDefName(t), allowed));
    if ((parsed.tools as unknown[]).length !== before) changed = true;
  }

  // OpenAI legacy `functions` array
  if (Array.isArray(parsed.functions)) {
    const before = (parsed.functions as unknown[]).length;
    parsed.functions = (parsed.functions as AnyRecord[]).filter((f) =>
      isAllowedDef(typeof f.name === "string" ? f.name : null, allowed),
    );
    if ((parsed.functions as unknown[]).length !== before) changed = true;
  }

  // Reset a forced tool_choice that points at a disallowed tool.
  const tc = parsed.tool_choice;
  if (tc && typeof tc === "object") {
    const tcr = tc as AnyRecord;
    const fn = tcr.function as AnyRecord | undefined;
    const forced = fn && typeof fn.name === "string"
      ? fn.name
      : typeof tcr.name === "string" // Anthropic: { type: "tool", name }
        ? tcr.name
        : null;
    if (forced !== null && !allowed.has(forced)) {
      parsed.tool_choice = "auto";
      changed = true;
    }
  }

  // OpenAI legacy `function_call: { name }`
  const fc = parsed.function_call;
  if (fc && typeof fc === "object") {
    const name = (fc as AnyRecord).name;
    if (typeof name === "string" && !allowed.has(name)) {
      parsed.function_call = "auto";
      changed = true;
    }
  }

  return changed;
}

/**
 * Remove disallowed tool *calls* from a buffered response body across provider
 * shapes. Mutates `parsed` in place; returns true when anything changed.
 */
function stripResponseCalls(parsed: AnyRecord, allowed: Set<string>): boolean {
  let changed = false;

  // Anthropic Messages: content[] tool_use blocks
  if (Array.isArray(parsed.content)) {
    const before = (parsed.content as unknown[]).length;
    parsed.content = (parsed.content as AnyRecord[]).filter(
      (b) => !(b.type === "tool_use" && typeof b.name === "string" && !allowed.has(b.name)),
    );
    if ((parsed.content as unknown[]).length !== before) changed = true;
  }

  // OpenAI Responses API: output[] function_call entries
  if (Array.isArray(parsed.output)) {
    const before = (parsed.output as unknown[]).length;
    parsed.output = (parsed.output as AnyRecord[]).filter(
      (e) => !(e.type === "function_call" && typeof e.name === "string" && !allowed.has(e.name)),
    );
    if ((parsed.output as unknown[]).length !== before) changed = true;
  }

  // OpenAI Chat Completions: choices[].message.tool_calls[]
  if (Array.isArray(parsed.choices)) {
    for (const choice of parsed.choices as AnyRecord[]) {
      const message = choice.message as AnyRecord | undefined;
      if (!message || !Array.isArray(message.tool_calls)) continue;
      const before = (message.tool_calls as unknown[]).length;
      message.tool_calls = (message.tool_calls as AnyRecord[]).filter((tc) => {
        const fn = tc.function as AnyRecord | undefined;
        const name = fn && typeof fn.name === "string" ? fn.name : null;
        return name === null || allowed.has(name);
      });
      if ((message.tool_calls as unknown[]).length !== before) {
        changed = true;
        if ((message.tool_calls as unknown[]).length === 0) delete message.tool_calls;
      }
    }
  }

  return changed;
}

function asRecord(ctx: RequestContext): AnyRecord | null {
  if (ctx.parsedBody && typeof ctx.parsedBody === "object") return ctx.parsedBody as AnyRecord;
  try {
    const v = JSON.parse(ctx.body);
    return v && typeof v === "object" ? (v as AnyRecord) : null;
  } catch {
    return null;
  }
}

/**
 * Enforce a per-rule tool allowlist. On the request pass (ctx.phase !== "output")
 * it strips disallowed tool definitions before forward. On the response pass it
 * either blocks the response or strips the disallowed tool calls, per
 * `on_violation`. Streaming responses never reach the output pass, so streaming
 * enforcement relies on the request-side strip.
 */
export async function executeRestrictTools(
  ctx: RequestContext,
  action: RestrictToolsAction,
): Promise<ActionResult> {
  const allowed = new Set(action.allowed_tools ?? []);

  // --- Response pass ---
  if (ctx.phase === "output") {
    if (!action.enforce?.response) return {};

    const uses = extractToolUses(ctx.parsedBody, ctx.body);
    const disallowed = uses.filter((u) => !allowed.has(u.name));
    if (disallowed.length === 0) return {};

    const names = Array.from(new Set(disallowed.map((u) => u.name)));

    if (action.on_violation === "block") {
      return {
        blocked: true,
        statusCode: action.block_status_code || 403,
        message: action.block_message || `Tool not permitted: ${names.join(", ")}`,
        tags: [{ severity: "critical", label: `restrict_tools:blocked:${names.join(",")}` }],
      };
    }

    // strip
    const parsed = asRecord(ctx);
    if (parsed && stripResponseCalls(parsed, allowed)) {
      ctx.body = JSON.stringify(parsed);
      ctx.parsedBody = parsed;
    }
    return { tags: [{ severity: "warn", label: `restrict_tools:stripped:${names.join(",")}` }] };
  }

  // --- Request pass ---
  if (!action.enforce?.request) return {};

  const parsed = asRecord(ctx);
  if (!parsed) return {};
  if (stripRequestTools(parsed, allowed)) {
    ctx.body = JSON.stringify(parsed);
    ctx.parsedBody = parsed;
  }
  return {};
}
