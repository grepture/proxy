import { describe, it, expect } from "bun:test";
import { executeRedactPii } from "../src/actions/redact-pii";
import { executeFindReplace } from "../src/actions/find-replace";
import type { RedactPiiAction, FindReplaceAction, RequestContext, AuthInfo } from "../src/types";
import type { TokenVault } from "../src/providers/types";

function makeCtx(body: unknown): RequestContext {
  const raw = JSON.stringify(body);
  return {
    requestId: "r", auth: { team_id: "t", user_id: "u", tier: "free", fallback_mode: "error", zero_data_mode: false } as AuthInfo,
    method: "POST", targetUrl: "https://api.anthropic.com/v1/messages",
    headers: {}, body: raw, parsedBody: JSON.parse(raw),
    startedAt: Date.now(), traceId: null, label: null, metadata: null, seq: null, sessionId: null,
  };
}

const noopVault: TokenVault = { async set() {}, async get() { return null; } };

const PHONE_MASK: RedactPiiAction = {
  id: "a1", enabled: true, type: "redact_pii",
  categories: ["phone"], replacement: "placeholder", mode: "mask_and_restore",
  token_prefix: "pii_", ttl_seconds: 60,
};

const ANTHROPIC_ID = "call_6172146963204e00a4896221";
const OPENAI_ID = "call_17205551234";

const anthropicBody = {
  model: "claude-sonnet-5-5",
  messages: [
    { role: "user", content: "Look up 555-123-4567" },
    { role: "assistant", content: [{ type: "tool_use", id: ANTHROPIC_ID, name: "lookup", input: { phone: "555-123-4567" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: ANTHROPIC_ID, content: "Owner of 555-123-4567: Jane" }] },
  ],
};

const openaiBody = {
  model: "gpt-4o",
  messages: [
    { role: "assistant", content: null, tool_calls: [{ id: OPENAI_ID, type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: OPENAI_ID, content: "call 555-123-4567" },
  ],
};

const responsesBody = {
  input: [
    { type: "function_call", id: "fc_17205551234", call_id: OPENAI_ID, name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: OPENAI_ID, output: "555-123-4567" },
  ],
};

describe("tool call IDs are excluded from detection", () => {
  it("redact_pii leaves Anthropic tool_use.id / tool_result.tool_use_id intact", async () => {
    const ctx = makeCtx(anthropicBody);
    await executeRedactPii(ctx, PHONE_MASK, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.messages[1].content[0].id).toBe(ANTHROPIC_ID);
    expect(out.messages[2].content[0].tool_use_id).toBe(ANTHROPIC_ID);
    // Real PII next to the IDs is still masked
    expect(out.messages[0].content).not.toContain("555-123-4567");
    expect(out.messages[1].content[0].input.phone).not.toContain("555-123-4567");
    expect(out.messages[2].content[0].content).not.toContain("555-123-4567");
  });

  it("redact_pii leaves OpenAI tool_calls[].id / tool_call_id intact", async () => {
    const ctx = makeCtx(openaiBody);
    await executeRedactPii(ctx, PHONE_MASK, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.messages[0].tool_calls[0].id).toBe(OPENAI_ID);
    expect(out.messages[1].tool_call_id).toBe(OPENAI_ID);
    expect(out.messages[1].content).not.toContain("555-123-4567");
  });

  it("redact_pii leaves Responses API id / call_id intact", async () => {
    const ctx = makeCtx(responsesBody);
    await executeRedactPii(ctx, PHONE_MASK, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.input[0].id).toBe("fc_17205551234");
    expect(out.input[0].call_id).toBe(OPENAI_ID);
    expect(out.input[1].call_id).toBe(OPENAI_ID);
    expect(out.input[1].output).not.toContain("555-123-4567");
  });

  it("still redacts an `id` field inside tool input (user data, not a tool ID)", async () => {
    const ctx = makeCtx({
      messages: [{ role: "assistant", content: [{ type: "tool_use", id: ANTHROPIC_ID, name: "x", input: { id: "555-123-4567" } }] }],
    });
    await executeRedactPii(ctx, PHONE_MASK, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.messages[0].content[0].input.id).not.toContain("555-123-4567");
  });

  it("find_replace leaves tool IDs intact", async () => {
    const action: FindReplaceAction = {
      id: "a2", enabled: true, type: "find_replace", find: "\\d{6,}", replace: "[N]",
      is_regex: true, case_sensitive: true, mode: "redact", token_prefix: "", ttl_seconds: 0,
    };
    const ctx = makeCtx(openaiBody);
    await executeFindReplace(ctx, action, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.messages[0].tool_calls[0].id).toBe(OPENAI_ID);
    expect(out.messages[1].tool_call_id).toBe(OPENAI_ID);
  });
});

describe("find_replace inline (?i) flag", () => {
  it("treats a leading (?i) as case-insensitive instead of rejecting the regex", async () => {
    const action: FindReplaceAction = {
      id: "a3", enabled: true, type: "find_replace",
      find: "(?i)pinecone[_-]?(?:api[_-]?)?key[\"']?\\s*[:=]\\s*[\"']?[A-Za-z0-9_-]{32,}[\"']?",
      replace: "[PINECONE_KEY]", is_regex: true, case_sensitive: true, mode: "redact",
    };
    const ctx = makeCtx({ messages: [{ role: "user", content: "PINECONE_API_KEY=abcdefghijklmnopqrstuvwxyz123456" }] });
    await executeFindReplace(ctx, action, noopVault);
    expect(JSON.parse(ctx.body).messages[0].content).toBe("[PINECONE_KEY]");
  });
});

describe("opaque provider blobs are never rewritten", () => {
  // A blob that contains a phone-number-shaped run and a find target.
  const BLOB = "EqQBCkgIARABGAIi555-123-4567QL+secretword/4ZbXW==";
  const SECRET_MASK: FindReplaceAction = {
    id: "a2", enabled: true, type: "find_replace", find: "secretword", replace: "[X]",
    is_regex: false, case_sensitive: false, mode: "mask_and_restore", token_prefix: "tok_", ttl_seconds: 60,
  };

  const body = {
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Call 555-123-4567", signature: BLOB },
          { type: "redacted_thinking", data: BLOB },
          { type: "text", text: "Found it", citations: [{ type: "web_search_result_location", url: "https://x.test", encrypted_index: BLOB, cited_text: "x" }] },
        ],
        reasoning_details: [
          { type: "reasoning.text", text: "secretword", signature: BLOB },
          { type: "reasoning.encrypted", data: BLOB },
        ],
      },
    ],
    input: [
      { type: "reasoning", encrypted_content: BLOB, summary: [] },
      { type: "compaction", encrypted_content: BLOB },
    ],
    contents: [{ parts: [{ text: "hi", thoughtSignature: BLOB }] }],
    tools_input: { signature: "555-123-4567" },
  };

  for (const [name, run] of [
    ["redact_pii", (ctx: RequestContext) => executeRedactPii(ctx, PHONE_MASK, noopVault)],
    ["find_replace", (ctx: RequestContext) => executeFindReplace(ctx, SECRET_MASK, noopVault)],
  ] as const) {
    it(`${name} leaves signatures, encrypted content and redacted thinking intact`, async () => {
      const ctx = makeCtx(body);
      await run(ctx);
      const out = JSON.parse(ctx.body);
      const msg = out.messages[0];
      expect(msg.content[0].signature).toBe(BLOB);
      expect(msg.content[1].data).toBe(BLOB);
      expect(msg.content[2].citations[0].encrypted_index).toBe(BLOB);
      expect(msg.reasoning_details[0].signature).toBe(BLOB);
      expect(msg.reasoning_details[1].data).toBe(BLOB);
      expect(out.input[0].encrypted_content).toBe(BLOB);
      expect(out.input[1].encrypted_content).toBe(BLOB);
      expect(out.contents[0].parts[0].thoughtSignature).toBe(BLOB);
    });
  }

  it("still redacts readable reasoning text and ordinary `signature` keys", async () => {
    const ctx = makeCtx(body);
    await executeRedactPii(ctx, PHONE_MASK, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.messages[0].content[0].thinking).not.toContain("555-123-4567");
    expect(out.tools_input.signature).not.toContain("555-123-4567");
  });
});

describe("Responses input item IDs are never rewritten", () => {
  const ID = "cmp_0123456789abcdef5551234567890123";
  const body = {
    previous_response_id: "resp_5551234567890",
    input: [
      { type: "compaction", id: ID, encrypted_content: "x" },
      { type: "reasoning", id: "rs_5551234567890", summary: [] },
      { type: "message", id: "msg_5551234567890", role: "assistant", content: [{ type: "output_text", text: "Call 555-123-4567" }] },
      { type: "function_call", id: "fc_5551234567890", call_id: "call_5551234567890", name: "f", arguments: "{}" },
      { type: "item_reference", id: "msg_5551234567891" },
      { type: "file_search_call", id: "fs_5551234567890", results: [{ file_id: "file-5551234567890", text: "ok" }] },
      { type: "code_interpreter_call", id: "ci_5551234567890", container_id: "cntr_5551234567890" },
      { type: "mcp_approval_response", id: "mcpr_5551234567890", approval_request_id: "mcpr_5551234567891", approve: true },
    ],
  };
  const DIGITS: FindReplaceAction = {
    id: "a4", enabled: true, type: "find_replace", find: "\\d{10,}", replace: "[N]",
    is_regex: true, case_sensitive: true, mode: "mask_and_restore", token_prefix: "tok_", ttl_seconds: 60,
  };

  it("leaves item and response IDs intact but redacts message text", async () => {
    const ctx = makeCtx(body);
    await executeFindReplace(ctx, DIGITS, noopVault);
    await executeRedactPii(ctx, PHONE_MASK, noopVault);
    const out = JSON.parse(ctx.body);
    expect(out.previous_response_id).toBe(body.previous_response_id);
    expect(out.input.map((i: { id: string }) => i.id)).toEqual(body.input.map((i) => i.id));
    expect(out.input[3].call_id).toBe("call_5551234567890");
    expect(out.input[5].results[0].file_id).toBe("file-5551234567890");
    expect(out.input[6].container_id).toBe("cntr_5551234567890");
    expect(out.input[7].approval_request_id).toBe("mcpr_5551234567891");
    expect(out.input[2].content[0].text).not.toContain("555-123-4567");
  });
});
