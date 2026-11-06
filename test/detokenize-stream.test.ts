import { describe, it, expect } from "bun:test";
import {
  createDetokenizeStream,
  extractDeltas,
  endsWithPartialToken,
} from "../src/proxy/detokenize-stream";
import type { TokenVault } from "../src/providers/types";
import {
  openaiDelta,
  anthropicDelta,
  encodeSSE,
  chunkedStream,
  OPENAI_DONE,
  ANTHROPIC_START,
  ANTHROPIC_PING,
} from "./fixtures/sse-chunks";

function makeVault(entries: Record<string, string> = {}): TokenVault {
  const store = new Map(Object.entries(entries));
  return {
    async set(_teamId: string, token: string, value: string) {
      store.set(token, value);
    },
    async get(_teamId: string, token: string) {
      return store.get(token) ?? null;
    },
  };
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

// ---------------------------------------------------------------------------
// extractDeltas
// ---------------------------------------------------------------------------
describe("extractDeltas", () => {
  it("extracts text from OpenAI delta content", () => {
    expect(extractDeltas(openaiDelta("hello")).map((d) => d.text)).toEqual(["hello"]);
  });

  it("extracts text from Anthropic delta text", () => {
    expect(extractDeltas(anthropicDelta("world")).map((d) => d.text)).toEqual(["world"]);
  });

  it("returns nothing for [DONE]", () => {
    expect(extractDeltas(OPENAI_DONE)).toEqual([]);
  });

  it("returns nothing for non-text events (ANTHROPIC_START)", () => {
    expect(extractDeltas(ANTHROPIC_START)).toEqual([]);
  });

  it("returns nothing for ping events", () => {
    expect(extractDeltas(ANTHROPIC_PING)).toEqual([]);
  });

  it("returns nothing for malformed JSON", () => {
    expect(extractDeltas("data: {not valid json")).toEqual([]);
  });

  it('returns empty string for empty content delta', () => {
    expect(extractDeltas(openaiDelta("")).map((d) => d.text)).toEqual([""]);
  });
});

// ---------------------------------------------------------------------------
// endsWithPartialToken
// ---------------------------------------------------------------------------
describe("endsWithPartialToken", () => {
  const prefixes = ["pii_"];
  const maxLen = 4 + 36; // prefix len + UUID len

  it("returns false for empty text", () => {
    expect(endsWithPartialToken("", prefixes, maxLen)).toBe(false);
  });

  it("detects partial prefix at end of text", () => {
    expect(endsWithPartialToken("hello p", prefixes, maxLen)).toBe(true);
    expect(endsWithPartialToken("hello pi", prefixes, maxLen)).toBe(true);
    expect(endsWithPartialToken("hello pii", prefixes, maxLen)).toBe(true);
    expect(endsWithPartialToken("hello pii_", prefixes, maxLen)).toBe(true);
  });

  it("detects prefix + partial UUID", () => {
    expect(endsWithPartialToken("hello pii_abcd1234", prefixes, maxLen)).toBe(true);
    expect(endsWithPartialToken("hello pii_aaaaaaaa-bbbb", prefixes, maxLen)).toBe(true);
  });

  it("detects complete token at end (partial UUID regex also matches full UUID)", () => {
    const fullToken = "pii_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(endsWithPartialToken("hello " + fullToken, prefixes, maxLen)).toBe(true);
  });

  it("returns false when no token-like suffix", () => {
    expect(endsWithPartialToken("hello world", prefixes, maxLen)).toBe(false);
    expect(endsWithPartialToken("hello 12345", prefixes, maxLen)).toBe(false);
  });

  it("works with multiple prefixes", () => {
    expect(endsWithPartialToken("value tok", ["pii_", "tok_"], maxLen)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createDetokenizeStream
// ---------------------------------------------------------------------------
describe("createDetokenizeStream", () => {
  const TOKEN = "pii_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const TEAM = "team-1";
  const ORIGINAL = "secret@example.com";

  it("detokenizes a complete token in a single chunk", async () => {
    const vault = makeVault({ [TOKEN]: ORIGINAL });
    const upstream = chunkedStream([
      encodeSSE(openaiDelta(`Your email is ${TOKEN}`), OPENAI_DONE),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).toContain(ORIGINAL);
    expect(output).not.toContain(TOKEN);
  });

  it("detokenizes a token split across two chunks", async () => {
    const vault = makeVault({ [TOKEN]: ORIGINAL });
    const part1 = TOKEN.slice(0, 12);
    const part2 = TOKEN.slice(12);

    const upstream = chunkedStream([
      encodeSSE(openaiDelta(part1)),
      encodeSSE(openaiDelta(part2)),
      encodeSSE(OPENAI_DONE),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).toContain(ORIGINAL);
    expect(output).not.toContain(TOKEN);
  });

  it("flushes when buffer limit (MAX_HELD=30) is reached", async () => {
    const vault = makeVault();
    // First event ends with "p" (partial prefix for "pii_"), causing holding.
    // Then 30 more events of "x" — should flush at 30 held without hanging.
    const events: string[] = [openaiDelta("hello p")];
    for (let i = 0; i < 30; i++) {
      events.push(openaiDelta("x"));
    }
    events.push(OPENAI_DONE);

    const upstream = chunkedStream([encodeSSE(...events)]);
    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).toContain("hello p");
  });

  it("passes through data in passthrough mode (empty prefixes)", async () => {
    const vault = makeVault();
    const upstream = chunkedStream([
      encodeSSE(openaiDelta("just text"), OPENAI_DONE),
    ]);

    const { stream, accumulated } = createDetokenizeStream(upstream, TEAM, [], vault);
    const output = await collectStream(stream);
    const body = await accumulated;

    expect(output).toContain("just text");
    expect(body).toContain("just text");
  });

  it("preserves non-text events", async () => {
    const vault = makeVault();
    const upstream = chunkedStream([
      encodeSSE(ANTHROPIC_START, anthropicDelta("hi"), ANTHROPIC_PING),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    // Both non-text events should be present in output
    expect(output).toContain("message_start");
    expect(output).toContain("event: ping");
  });

  it("resolves accumulated promise with full body", async () => {
    const vault = makeVault();
    const upstream = chunkedStream([
      encodeSSE(openaiDelta("hello"), openaiDelta(" world"), OPENAI_DONE),
    ]);

    const { stream, accumulated } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    await collectStream(stream); // consume the stream first
    const body = await accumulated;

    expect(body).toContain("hello");
    expect(body).toContain("world");
  });

  it("emits [TOKEN_EXPIRED] for tokens not in vault", async () => {
    const vault = makeVault(); // empty vault
    const upstream = chunkedStream([
      encodeSSE(openaiDelta(`Your email is ${TOKEN}`), OPENAI_DONE),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).toContain("[TOKEN_EXPIRED]");
    expect(output).not.toContain(TOKEN);
  });

  // OpenAI Responses API streams text as `response.output_text.delta` events
  // with `delta` as a plain string, not an object. The detokenize stream needs
  // to extract and replace that shape too, otherwise mask-and-restore tokens
  // stream through untouched for GPT-5 / o-series traffic.
  function responsesDelta(text: string): string {
    return `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      item_id: "msg_test",
      output_index: 0,
      content_index: 0,
      delta: text,
    })}`;
  }

  it("detokenizes a complete token in a Responses API delta event", async () => {
    const vault = makeVault({ [TOKEN]: ORIGINAL });
    const upstream = chunkedStream([
      encodeSSE(responsesDelta(`Your email is ${TOKEN}`), OPENAI_DONE),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).toContain(ORIGINAL);
    expect(output).not.toContain(TOKEN);
  });

  it("detokenizes tokens in response.output_text.done and response.completed terminal events", async () => {
    // TypingMind reads the full text from the terminal events, not the deltas.
    // If we only detokenize deltas, the terminal events leak the raw tokens
    // and the rendered message ends up showing pii_<uuid>.
    const vault = makeVault({ [TOKEN]: ORIGINAL });
    const fullText = `Hi there. Your email is ${TOKEN}, take care.`;

    const outputTextDone = `event: response.output_text.done\ndata: ${JSON.stringify({
      type: "response.output_text.done",
      content_index: 0,
      item_id: "msg_test",
      output_index: 0,
      text: fullText,
    })}`;

    const completed = `event: response.completed\ndata: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: "resp_test",
        output: [
          {
            id: "msg_test",
            type: "message",
            content: [{ type: "output_text", text: fullText }],
          },
        ],
      },
    })}`;

    const upstream = chunkedStream([encodeSSE(outputTextDone, completed)]);
    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    // Token must NOT appear anywhere in either terminal event.
    expect(output).not.toContain(TOKEN);
    // Original value should appear in both events.
    const occurrences = output.split(ORIGINAL).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("detokenizes a Responses API token split across two delta events", async () => {
    const vault = makeVault({ [TOKEN]: ORIGINAL });
    const part1 = TOKEN.slice(0, 12);
    const part2 = TOKEN.slice(12);

    const upstream = chunkedStream([
      encodeSSE(responsesDelta(part1)),
      encodeSSE(responsesDelta(part2)),
      encodeSSE(OPENAI_DONE),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).toContain(ORIGINAL);
    expect(output).not.toContain(TOKEN);
  });
});

describe("Anthropic streaming with split tokens (regression)", () => {
  // TypingMind → Anthropic via /anthropic/<key>/v1/messages.
  // Upstream Anthropic splits a long token across two content_block_delta
  // events. The streaming detokenizer must hold the first event, merge with
  // the second, and emit a single detokenized event.
  it("detokenizes a token split across two Anthropic content_block_delta events", async () => {
    const TOKEN_ANT = "pii_d1f00d3f-8687-484e-8b1d-04362fc2afc7";
    const ORIGINAL_ANT = "California";
    const TEAM_ANT = "team-1";

    const vault: TokenVault = {
      async set() {},
      async get(_t, token) {
        return token === TOKEN_ANT ? ORIGINAL_ANT : null;
      },
    };

    // Split the token across two deltas at the same offset Anthropic split it
    // in the reported case: 34 chars after prefix in the first delta, then "c7"
    // appended in the second.
    const head = TOKEN_ANT.slice(0, -2); // "pii_...04362fc2af"
    const tail = TOKEN_ANT.slice(-2);    // "c7"

    const delta3 =
      `event: content_block_delta\n` +
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `123 Newell Road, ${head}` },
      })}`;

    const delta4 =
      `event: content_block_delta\n` +
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${tail}\n- Employer: ACME` },
      })}`;

    const stop = `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`;

    const upstream = chunkedStream([encodeSSE(delta3, delta4, stop)]);
    const { stream } = createDetokenizeStream(upstream, TEAM_ANT, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).not.toContain(TOKEN_ANT);
    expect(output).not.toContain(head);
    expect(output).toContain(ORIGINAL_ANT);
  });

  // Regression for the Anthropic case where TWO tokens are split across THREE
  // consecutive deltas: token A ends in delta 1, completes in delta 2; then
  // token B starts in delta 2 and completes in delta 3. The old logic flushed
  // eagerly when delta 2 brought token A to completion, abandoning the trailing
  // partial of token B and leaking both halves raw.
  it("detokenizes two back-to-back split tokens across three deltas", async () => {
    const TOKEN_A = "pii_321b0f89-7720-4d51-aa3c-f99489e06f05";
    const TOKEN_B = "pii_f32c8210-ee86-44a6-be15-ed6187f40b53";
    const ORIGINAL_A = "California";
    const ORIGINAL_B = "Vizio Pharmaceutical";
    const TEAM_ANT = "team-1";

    const vault: TokenVault = {
      async set() {},
      async get(_t, token) {
        if (token === TOKEN_A) return ORIGINAL_A;
        if (token === TOKEN_B) return ORIGINAL_B;
        return null;
      },
    };

    // Mirror Anthropic's actual split boundaries from the reported trace.
    // Token A: head ends in "aa3", tail starts with "c-f99489e06f05".
    // Token B: head ends in "ee86-44a6", tail starts with "-be15-...".
    const aHeadReal = TOKEN_A.slice(0, TOKEN_A.indexOf("c-"));
    const aTailReal = TOKEN_A.slice(TOKEN_A.indexOf("c-"));
    const bHeadReal = TOKEN_B.slice(0, TOKEN_B.indexOf("-be15"));
    const bTailReal = TOKEN_B.slice(TOKEN_B.indexOf("-be15"));

    const d1 =
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `Address: 123 ${aHeadReal}` },
      })}`;
    const d2 =
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${aTailReal}\nEmployer: ${bHeadReal}` },
      })}`;
    const d3 =
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${bTailReal}\nDone.` },
      })}`;

    const upstream = chunkedStream([encodeSSE(d1, d2, d3)]);
    const { stream } = createDetokenizeStream(upstream, TEAM_ANT, ["pii_"], vault);
    const output = await collectStream(stream);

    // Neither raw token should leak anywhere
    expect(output).not.toContain(TOKEN_A);
    expect(output).not.toContain(TOKEN_B);
    // No partial fragments either
    expect(output).not.toContain(aHeadReal);
    expect(output).not.toContain(bHeadReal);
    // Both originals should appear
    expect(output).toContain(ORIGINAL_A);
    expect(output).toContain(ORIGINAL_B);
  });

  // Same as above but the two deltas arrive in *separate* network chunks —
  // the transform's sseBuffer must carry state between transform() calls.
  it("detokenizes a split token across separate network chunks", async () => {
    const TOKEN_ANT = "pii_aabbccdd-eeff-0011-2233-445566778899";
    const ORIGINAL_ANT = "California";
    const TEAM_ANT = "team-1";

    const vault: TokenVault = {
      async set() {},
      async get(_t, token) {
        return token === TOKEN_ANT ? ORIGINAL_ANT : null;
      },
    };

    const head = TOKEN_ANT.slice(0, -2);
    const tail = TOKEN_ANT.slice(-2);

    const delta3 =
      `event: content_block_delta\n` +
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `Address: ${head}` },
      })}`;

    const delta4 =
      `event: content_block_delta\n` +
      `data: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `${tail}, done` },
      })}`;

    const upstream = chunkedStream([
      encodeSSE(delta3),
      encodeSSE(delta4),
    ]);

    const { stream } = createDetokenizeStream(upstream, TEAM_ANT, ["pii_"], vault);
    const output = await collectStream(stream);

    expect(output).not.toContain(TOKEN_ANT);
    expect(output).not.toContain(head);
    expect(output).toContain(ORIGINAL_ANT);
  });
});

describe("extractDeltas — Responses API", () => {
  it("extracts text from a response.output_text.delta event (delta as string)", () => {
    const event = `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: "response.output_text.delta",
      delta: "hello world",
    })}`;
    expect(extractDeltas(event).map((d) => d.text)).toEqual(["hello world"]);
  });

  it("returns nothing for non-text Responses events (response.created)", () => {
    const event = `event: response.created\ndata: ${JSON.stringify({
      type: "response.created",
      response: { id: "resp_test" },
    })}`;
    expect(extractDeltas(event)).toEqual([]);
  });
});

describe("restore in non-text stream fields", () => {
  const TEAM = "team-1";
  const TOKEN = "pii_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const ORIGINAL = 'Jane "JD" Doe';
  const head = TOKEN.slice(0, 15);
  const tail = TOKEN.slice(15);
  const data = (json: unknown) => `data: ${JSON.stringify(json)}`;

  async function run(events: string[]): Promise<string> {
    const vault = makeVault({ [TOKEN]: ORIGINAL });
    const upstream = chunkedStream(events.map((e) => encodeSSE(e)));
    const { stream } = createDetokenizeStream(upstream, TEAM, ["pii_"], vault);
    return collectStream(stream);
  }

  /** Concatenates one field across all emitted events. */
  function joined(output: string, pick: (json: Record<string, any>) => unknown): string {
    return output
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => pick(JSON.parse(line.slice(6))))
      .filter((v): v is string => typeof v === "string")
      .join("");
  }

  it("restores split tokens in OpenAI tool_calls arguments, JSON-escaped", async () => {
    const call = (args: string, extra: Record<string, unknown> = {}) =>
      data({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, ...extra, function: { arguments: args } }] } }] });
    const output = await run([
      call("", { id: "call_1", type: "function" }),
      call(`{"name":"${head}`),
      call(`${tail}"}`),
      OPENAI_DONE,
    ]);
    expect(output).not.toContain(head);
    expect(output).toContain('"id":"call_1"');
    const args = joined(output, (j) => j.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments);
    expect(JSON.parse(args)).toEqual({ name: ORIGINAL });
  });

  it("restores split tokens in Anthropic input_json_delta.partial_json", async () => {
    const part = (partial_json: string) =>
      data({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } });
    const output = await run([part(`{"name":"${head}`), part(`${tail}"}`)]);
    expect(output).not.toContain(head);
    expect(JSON.parse(joined(output, (j) => j.delta?.partial_json))).toEqual({ name: ORIGINAL });
  });

  it("restores split tokens in Anthropic thinking_delta.thinking", async () => {
    const think = (thinking: string) =>
      data({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } });
    const output = await run([think(`User is ${head}`), think(`${tail}.`)]);
    expect(joined(output, (j) => j.delta?.thinking)).toBe(`User is ${ORIGINAL}.`);
  });

  it("restores reasoning_content and reasoning in OpenAI-compatible chunks", async () => {
    const chunk = (delta: Record<string, string>) => data({ choices: [{ index: 0, delta }] });
    const output = await run([
      chunk({ reasoning_content: `A ${head}` }),
      chunk({ reasoning: `B ${head}` }),
      chunk({ reasoning_content: tail }),
      chunk({ reasoning: tail }),
      OPENAI_DONE,
    ]);
    expect(output).not.toContain(head);
    expect(joined(output, (j) => j.choices?.[0]?.delta?.reasoning_content)).toBe(`A ${ORIGINAL}`);
    expect(joined(output, (j) => j.choices?.[0]?.delta?.reasoning)).toBe(`B ${ORIGINAL}`);
  });

  it("keeps channels separate when a token in one interleaves with text in another", async () => {
    const chunk = (delta: Record<string, string>) => data({ choices: [{ index: 0, delta }] });
    const output = await run([
      chunk({ reasoning_content: head }),
      chunk({ content: "Hello " }),
      chunk({ reasoning_content: tail }),
      chunk({ content: "world" }),
      OPENAI_DONE,
    ]);
    expect(joined(output, (j) => j.choices?.[0]?.delta?.reasoning_content)).toBe(ORIGINAL);
    expect(joined(output, (j) => j.choices?.[0]?.delta?.content)).toBe("Hello world");
  });

  it("restores Responses function_call_arguments deltas and the done event", async () => {
    const delta = (d: string) =>
      `event: response.function_call_arguments.delta\n${data({ type: "response.function_call_arguments.delta", output_index: 0, delta: d })}`;
    const done = `event: response.function_call_arguments.done\n${data({
      type: "response.function_call_arguments.done",
      output_index: 0,
      arguments: `{"name":"${TOKEN}"}`,
    })}`;
    const output = await run([delta(`{"name":"${head}`), delta(`${tail}"}`), done]);
    expect(output).not.toContain(head);
    expect(JSON.parse(joined(output, (j) => (typeof j.delta === "string" ? j.delta : undefined)))).toEqual({ name: ORIGINAL });
    expect(JSON.parse(joined(output, (j) => j.arguments))).toEqual({ name: ORIGINAL });
  });

  it("restores Responses reasoning summary deltas", async () => {
    const delta = (d: string) =>
      data({ type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: d });
    const output = await run([delta(`Hi ${head}`), delta(tail)]);
    expect(joined(output, (j) => j.delta)).toBe(`Hi ${ORIGINAL}`);
  });
});
