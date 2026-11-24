import { describe, expect, test } from "bun:test";
import { transformOutsideTokens, transformStrings } from "../src/actions/transform-strings";

const TOKEN = "pii_9d6fcb5d-af3d-4f4f-82fe-db1234567890";
const digitsToX = async (s: string) => s.replace(/\d{6,}/g, "X");

describe("transformOutsideTokens", () => {
  test("leaves an earlier rule's token intact", async () => {
    expect(await transformOutsideTokens(`SSN (${TOKEN} entity): 1234567`, digitsToX))
      .toBe(`SSN (${TOKEN} entity): X`);
  });

  test("passes token-free strings through whole", async () => {
    expect(await transformOutsideTokens("call 1234567", digitsToX)).toBe("call X");
  });

  test("handles a string that is only a token", async () => {
    expect(await transformOutsideTokens(TOKEN, digitsToX)).toBe(TOKEN);
  });

  test("applies to string leaves in transformStrings", async () => {
    const out = await transformStrings({ messages: [{ role: "user", content: `${TOKEN} 9999999` }] }, digitsToX);
    expect(out).toEqual({ messages: [{ role: "user", content: `${TOKEN} X` }] });
  });
});
