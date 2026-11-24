import { detectPii } from "../pii/detector";
import { replacePii, placeholders } from "../pii/replacer";
import { transformStrings } from "../actions/transform-strings";
import { extractDeltas, parseData, replaceDeltas } from "./detokenize-stream";
import type { PiiCategory } from "../types";

const redactText = (categories: PiiCategory[]) => (s: string) =>
  replacePii(s, detectPii(s, categories), "placeholder");

/**
 * Re-redacts mask & restore PII from a response body before it is logged.
 * Only string values are scanned, so numeric fields such as `created` can't
 * match a pattern and break the JSON. Streamed text is scanned per generated
 * field across all its deltas, so a value split over several chunks is
 * redacted whole instead of leaving fragments behind.
 */
export async function redactForLog(body: string, categories: PiiCategory[]): Promise<string> {
  if (categories.length === 0 || body === "") return body;

  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") {
      return JSON.stringify(await transformStrings(parsed, redactText(categories)));
    }
  } catch {
    // Not a single JSON document: SSE or plain text
  }

  if (!/^data: /m.test(body)) return redactText(categories)(body);
  return redactSse(body, categories);
}

interface Piece { event: number; channel: string; start: number; end: number }

async function redactSse(body: string, categories: PiiCategory[]): Promise<string> {
  const events = body.split("\n\n");

  // Reassemble each generated field (content, tool arguments, …) and remember
  // where every delta sits in it.
  const channelText = new Map<string, string>();
  const pieces: Piece[] = [];
  events.forEach((event, i) => {
    for (const { channel, text } of extractDeltas(event)) {
      const start = channelText.get(channel)?.length ?? 0;
      channelText.set(channel, (channelText.get(channel) ?? "") + text);
      pieces.push({ event: i, channel, start, end: start + text.length });
    }
  });

  // A match is replaced by its placeholder in the delta where it starts; its
  // remaining characters are dropped from that and any later deltas.
  const rewrites = new Map<number, Map<string, string>>();
  for (const [channel, text] of channelText) {
    const matches = detectPii(text, categories);
    if (matches.length === 0) continue;
    for (const p of pieces) {
      if (p.channel !== channel) continue;
      let out = "";
      let pos = p.start;
      for (const m of matches) {
        if (m.end <= p.start || m.start >= p.end) continue;
        if (m.start > pos) out += text.slice(pos, m.start);
        if (m.start >= p.start) out += placeholders[m.category] ?? "[REDACTED]";
        pos = Math.max(pos, Math.min(m.end, p.end));
      }
      if (pos === p.start && out === "") continue; // untouched
      out += text.slice(pos, p.end);
      if (!rewrites.has(p.event)) rewrites.set(p.event, new Map());
      rewrites.get(p.event)!.set(channel, out);
    }
  }

  const out: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const texts = rewrites.get(i);
    if (texts) {
      out.push(replaceDeltas(event, texts));
      continue;
    }
    // Events without deltas (e.g. Responses terminal events with the full
    // text, Anthropic message_start) are redacted value by value.
    const parsed = extractDeltas(event).length === 0 ? parseData(event) : null;
    if (parsed) {
      parsed.lines[parsed.index] = "data: " + JSON.stringify(await transformStrings(parsed.json, redactText(categories)));
      out.push(parsed.lines.join("\n"));
    } else {
      out.push(event);
    }
  }
  return out.join("\n\n");
}
