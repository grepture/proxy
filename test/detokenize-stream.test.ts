import { describe, it, expect } from "bun:test";
import {
  createDetokenizeStream,
  extractText,
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
// extractText
// ---------------------------------------------------------------------------
describe("extractText", () => {
  it("extracts text from OpenAI delta content", () => {
    expect(extractText(openaiDelta("hello"))).toBe("hello");
  });

  it("extracts text from Anthropic delta text", () => {
    expect(extractText(anthropicDelta("world"))).toBe("world");
  });

  it("returns null for [DONE]", () => {
    expect(extractText(OPENAI_DONE)).toBeNull();
  });

  it("returns null for non-text events (ANTHROPIC_START)", () => {
    expect(extractText(ANTHROPIC_START)).toBeNull();
  });

  it("returns null for ping events", () => {
    expect(extractText(ANTHROPIC_PING)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(extractText("data: {not valid json")).toBeNull();
  });

  it('returns empty string for empty content delta', () => {
    expect(extractText(openaiDelta(""))).toBe("");
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
});
