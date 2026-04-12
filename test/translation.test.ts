import { describe, it, expect } from "bun:test";
import { translateRequest, translateResponse } from "../src/translation";

// ─── Request: OpenAI → Anthropic ────────────────────────────────────────────

describe("translateRequest: OpenAI → Anthropic", () => {
  it("moves system messages to top-level system field", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ],
    };
    const result = translateRequest("openai", "anthropic", body, "claude-sonnet-4-5-20250929");
    expect(result.system).toBe("You are helpful");
    expect((result.messages as Array<{ role: string }>).every((m) => m.role !== "system")).toBe(true);
  });

  it("sets max_tokens default of 4096 when not specified", () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] };
    const result = translateRequest("openai", "anthropic", body, "claude-sonnet-4-5-20250929");
    expect(result.max_tokens).toBe(4096);
  });

  it("overrides model with the provided default_model", () => {
    const body = { model: "gpt-4o", messages: [{ role: "user", content: "Hi" }] };
    const result = translateRequest("openai", "anthropic", body, "claude-sonnet-4-5-20250929");
    expect(result.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("translates tools from OpenAI to Anthropic format", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "weather?" }],
      tools: [
        {
          type: "function",
          function: {
            name: "get_weather",
            description: "Get weather",
            parameters: { type: "object", properties: { location: { type: "string" } } },
          },
        },
      ],
    };
    const result = translateRequest("openai", "anthropic", body, "claude-sonnet-4-5-20250929");
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_weather");
    expect(tools[0].input_schema).toEqual({ type: "object", properties: { location: { type: "string" } } });
    // Should not have OpenAI's nested function wrapper
    expect(tools[0].function).toBeUndefined();
  });

  it("translates tool_choice", () => {
    const body = {
      model: "gpt-4o",
      messages: [{ role: "user", content: "Hi" }],
      tools: [{ type: "function", function: { name: "f", description: "d", parameters: {} } }],
      tool_choice: "required",
    };
    const result = translateRequest("openai", "anthropic", body, "claude-sonnet-4-5-20250929");
    expect(result.tool_choice).toEqual({ type: "any" });
  });

  it("translates assistant tool_calls to tool_use content blocks", () => {
    const body = {
      model: "gpt-4o",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"NYC"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "72°F" },
        { role: "user", content: "thanks" },
      ],
    };
    const result = translateRequest("openai", "anthropic", body, "claude-sonnet-4-5-20250929");
    const msgs = result.messages as Array<Record<string, unknown>>;

    // assistant with tool_use blocks
    expect(msgs[1].role).toBe("assistant");
    const blocks = msgs[1].content as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe("tool_use");
    expect(blocks[0].name).toBe("get_weather");
    expect(blocks[0].input).toEqual({ location: "NYC" });

    // tool result merged into user message
    expect(msgs[2].role).toBe("user");
    const resultBlocks = msgs[2].content as Array<Record<string, unknown>>;
    expect(resultBlocks[0].type).toBe("tool_result");
    expect(resultBlocks[0].tool_use_id).toBe("call_1");
  });
});

// ─── Request: Anthropic → OpenAI ────────────────────────────────────────────

describe("translateRequest: Anthropic → OpenAI", () => {
  it("moves top-level system to first system message", () => {
    const body = {
      model: "claude-sonnet-4-5-20250929",
      system: "You are helpful",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
    };
    const result = translateRequest("anthropic", "openai", body, "gpt-4o");
    const msgs = result.messages as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: "system", content: "You are helpful" });
  });

  it("translates tool_use blocks to tool_calls", () => {
    const body = {
      model: "claude-sonnet-4-5-20250929",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: [
            { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "NYC" } },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "72°F" }],
        },
      ],
      max_tokens: 1024,
    };
    const result = translateRequest("anthropic", "openai", body, "gpt-4o");
    const msgs = result.messages as Array<Record<string, unknown>>;

    // assistant with tool_calls
    const toolCalls = msgs[1].tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe("get_weather");

    // tool result as role:"tool" message
    expect(msgs[2].role).toBe("tool");
    expect(msgs[2].tool_call_id).toBe("toolu_1");
  });

  it("translates Anthropic tools to OpenAI format", () => {
    const body = {
      model: "claude-sonnet-4-5-20250929",
      messages: [{ role: "user", content: "Hi" }],
      max_tokens: 1024,
      tools: [{ name: "get_weather", description: "Get weather", input_schema: { type: "object" } }],
      tool_choice: { type: "any" },
    };
    const result = translateRequest("anthropic", "openai", body, "gpt-4o");
    const tools = result.tools as Array<Record<string, unknown>>;
    expect(tools[0].type).toBe("function");
    expect((tools[0].function as Record<string, unknown>).name).toBe("get_weather");
    expect(result.tool_choice).toBe("required");
  });
});

// ─── Response: Anthropic → OpenAI ──────────────────────────────────────────

describe("translateResponse: Anthropic → OpenAI", () => {
  it("translates text response with usage", () => {
    const body = {
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = translateResponse("anthropic", "openai", body);
    expect(result.id).toBe("chatcmpl-test");
    expect(result.object).toBe("chat.completion");
    const choice = (result.choices as Array<Record<string, unknown>>)[0];
    expect((choice.message as Record<string, unknown>).content).toBe("Hello!");
    expect(choice.finish_reason).toBe("stop");
    const usage = result.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
  });

  it("translates tool_use response", () => {
    const body = {
      id: "msg_tool",
      type: "message",
      role: "assistant",
      content: [
        { type: "tool_use", id: "toolu_1", name: "get_weather", input: { location: "NYC" } },
      ],
      model: "claude-sonnet-4-5-20250929",
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 8 },
    };
    const result = translateResponse("anthropic", "openai", body);
    const choice = (result.choices as Array<Record<string, unknown>>)[0];
    expect(choice.finish_reason).toBe("tool_calls");
    const msg = choice.message as Record<string, unknown>;
    expect(msg.content).toBeNull(); // no text, only tool calls
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect((toolCalls[0].function as Record<string, unknown>).name).toBe("get_weather");
    expect(JSON.parse((toolCalls[0].function as Record<string, unknown>).arguments as string)).toEqual({ location: "NYC" });
  });
});

// ─── Response: OpenAI → Anthropic ──────────────────────────────────────────

describe("translateResponse: OpenAI → Anthropic", () => {
  it("translates text response", () => {
    const body = {
      id: "chatcmpl-test",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    const result = translateResponse("openai", "anthropic", body);
    expect(result.id).toBe("msg_test");
    expect(result.type).toBe("message");
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].text).toBe("Hello!");
    expect(result.stop_reason).toBe("end_turn");
    const usage = result.usage as Record<string, number>;
    expect(usage.input_tokens).toBe(10);
    expect(usage.output_tokens).toBe(5);
  });

  it("translates tool_calls response", () => {
    const body = {
      id: "chatcmpl-tool",
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"location":"NYC"}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
    };
    const result = translateResponse("openai", "anthropic", body);
    expect(result.stop_reason).toBe("tool_use");
    const content = result.content as Array<Record<string, unknown>>;
    expect(content[0].type).toBe("tool_use");
    expect(content[0].name).toBe("get_weather");
    expect(content[0].input).toEqual({ location: "NYC" });
  });

  it("identity translation preserves body", () => {
    const body = { id: "test", choices: [{ message: { content: "hi" } }] };
    const result = translateResponse("openai", "openai", body);
    expect(result).toEqual(body);
  });
});
