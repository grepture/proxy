import { describe, it, expect } from "bun:test";
import { executeRestrictTools } from "../src/actions/restrict-tools";
import type { RestrictToolsAction, RequestContext, AuthInfo } from "../src/types";

function makeCtx(body: string, phase: "input" | "output"): RequestContext {
  return {
    requestId: "test-req",
    auth: { team_id: "t", user_id: "u", tier: "free", fallback_mode: "error", zero_data_mode: false } as AuthInfo,
    method: "POST",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    headers: {},
    body,
    parsedBody: JSON.parse(body),
    startedAt: Date.now(),
    traceId: null, label: null, metadata: null, seq: null, sessionId: null,
    phase,
  };
}

const BASE: RestrictToolsAction = {
  id: "a1", enabled: true, type: "restrict_tools",
  allowed_tools: ["get_weather"],
  enforce: { request: true, response: true },
  on_violation: "block",
  block_status_code: 403,
  block_message: "Tool not permitted",
};

describe("restrict_tools — request pass (strip definitions)", () => {
  it("strips disallowed OpenAI Chat tool defs and resets forced tool_choice", async () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { type: "function", function: { name: "get_weather" } },
        { type: "function", function: { name: "delete_file" } },
      ],
      tool_choice: { type: "function", function: { name: "delete_file" } },
    });
    const ctx = makeCtx(body, "input");
    const res = await executeRestrictTools(ctx, BASE);
    expect(res.blocked).toBeFalsy();
    const parsed = JSON.parse(ctx.body);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].function.name).toBe("get_weather");
    expect(parsed.tool_choice).toBe("auto");
  });

  it("strips disallowed Anthropic tool defs (name at top level)", async () => {
    const body = JSON.stringify({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "get_weather", input_schema: {} },
        { name: "delete_file", input_schema: {} },
      ],
    });
    const ctx = makeCtx(body, "input");
    await executeRestrictTools(ctx, BASE);
    const parsed = JSON.parse(ctx.body);
    expect(parsed.tools.map((t: { name: string }) => t.name)).toEqual(["get_weather"]);
  });

  it("leaves unnamed/built-in tools untouched", async () => {
    const body = JSON.stringify({
      model: "gpt-4o",
      messages: [],
      tools: [{ type: "web_search" }, { type: "function", function: { name: "delete_file" } }],
    });
    const ctx = makeCtx(body, "input");
    await executeRestrictTools(ctx, BASE);
    const parsed = JSON.parse(ctx.body);
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].type).toBe("web_search");
  });

  it("does nothing when enforce.request is off", async () => {
    const body = JSON.stringify({ tools: [{ type: "function", function: { name: "delete_file" } }] });
    const ctx = makeCtx(body, "input");
    await executeRestrictTools(ctx, { ...BASE, enforce: { request: false, response: true } });
    expect(JSON.parse(ctx.body).tools).toHaveLength(1);
  });
});

describe("restrict_tools — response pass", () => {
  it("blocks when a disallowed Anthropic tool_use appears", async () => {
    const body = JSON.stringify({
      content: [
        { type: "text", text: "ok" },
        { type: "tool_use", id: "tu_1", name: "delete_file", input: {} },
      ],
    });
    const ctx = makeCtx(body, "output");
    const res = await executeRestrictTools(ctx, BASE);
    expect(res.blocked).toBe(true);
    expect(res.statusCode).toBe(403);
  });

  it("allows when all tool_use calls are permitted", async () => {
    const body = JSON.stringify({
      content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }],
    });
    const ctx = makeCtx(body, "output");
    const res = await executeRestrictTools(ctx, BASE);
    expect(res.blocked).toBeFalsy();
  });

  it("strips disallowed OpenAI Chat tool_calls when on_violation=strip", async () => {
    const body = JSON.stringify({
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "get_weather", arguments: "{}" } },
            { id: "c2", type: "function", function: { name: "delete_file", arguments: "{}" } },
          ],
        },
      }],
    });
    const ctx = makeCtx(body, "output");
    const res = await executeRestrictTools(ctx, { ...BASE, on_violation: "strip" });
    expect(res.blocked).toBeFalsy();
    const parsed = JSON.parse(ctx.body);
    expect(parsed.choices[0].message.tool_calls).toHaveLength(1);
    expect(parsed.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
  });

  it("strips disallowed OpenAI Responses output entries", async () => {
    const body = JSON.stringify({
      output: [
        { type: "function_call", call_id: "c1", name: "get_weather", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "delete_file", arguments: "{}" },
      ],
    });
    const ctx = makeCtx(body, "output");
    await executeRestrictTools(ctx, { ...BASE, on_violation: "strip" });
    const parsed = JSON.parse(ctx.body);
    expect(parsed.output).toHaveLength(1);
    expect(parsed.output[0].name).toBe("get_weather");
  });

  it("does nothing when enforce.response is off", async () => {
    const body = JSON.stringify({ content: [{ type: "tool_use", id: "x", name: "delete_file", input: {} }] });
    const ctx = makeCtx(body, "output");
    const res = await executeRestrictTools(ctx, { ...BASE, enforce: { request: true, response: false } });
    expect(res.blocked).toBeFalsy();
  });
});
