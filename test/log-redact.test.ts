import { describe, expect, test } from "bun:test";
import { redactForLog } from "../src/proxy/log-redact";

const chunk = (delta: Record<string, unknown>) =>
  `data: ${JSON.stringify({ id: "chatcmpl-1", created: 1795511575, choices: [{ index: 0, delta }] })}`;

function contentOf(sse: string): string {
  let out = "";
  for (const event of sse.split("\n\n")) {
    if (!event.startsWith("data: {")) continue;
    out += JSON.parse(event.slice(6)).choices[0].delta.content ?? "";
  }
  return out;
}

describe("redactForLog", () => {
  test("redacts a phone number split across stream chunks as a whole", async () => {
    const sse = [
      chunk({ content: "call +" }), chunk({ content: "49" }), chunk({ content: " 151 2345678" }),
      chunk({ content: "9" }), chunk({ content: " if late." }), "data: [DONE]", "",
    ].join("\n\n");
    const out = await redactForLog(sse, ["phone"]);
    expect(contentOf(out)).toBe("call [PHONE_REDACTED] if late.");
  });

  test("leaves numeric JSON fields alone", async () => {
    const sse = [chunk({ content: "hello" }), "data: [DONE]", ""].join("\n\n");
    const out = await redactForLog(sse, ["phone"]);
    expect(out).toBe(sse);
  });

  test("redacts tool call arguments across chunks", async () => {
    const tool = (args: string) => chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });
    const sse = [tool('{"text":"mail sarah.mu'), tool('eller@example.com now"}'), ""].join("\n\n");
    const out = await redactForLog(sse, ["email"]);
    const args = out.split("\n\n").filter((e) => e.startsWith("data: ")).map((e) => JSON.parse(e.slice(6)).choices[0].delta.tool_calls[0].function.arguments).join("");
    expect(JSON.parse(args)).toEqual({ text: "mail [EMAIL_REDACTED] now" });
  });

  test("redacts string values in a buffered JSON body only", async () => {
    const body = JSON.stringify({ created: 1795511575, choices: [{ message: { content: "call +49 151 23456789" } }] });
    const out = JSON.parse(await redactForLog(body, ["phone"]));
    expect(out.created).toBe(1795511575);
    expect(out.choices[0].message.content).toBe("call [PHONE_REDACTED]");
  });
});
