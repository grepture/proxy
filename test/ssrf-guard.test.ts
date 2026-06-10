import { describe, it, expect } from "bun:test";
import { assertSafeTarget, SsrfBlockedError } from "../src/proxy/ssrf-guard";

async function rejects(url: string): Promise<boolean> {
  try {
    await assertSafeTarget(url);
    return false;
  } catch (err) {
    return err instanceof SsrfBlockedError;
  }
}

describe("assertSafeTarget", () => {
  it("blocks the cloud metadata endpoint", async () => {
    expect(await rejects("http://169.254.169.254/latest/meta-data/")).toBe(true);
  });

  it("blocks loopback (IPv4 literal)", async () => {
    expect(await rejects("http://127.0.0.1:8080/")).toBe(true);
    expect(await rejects("http://127.5.6.7/")).toBe(true);
  });

  it("blocks private ranges (10/8, 172.16/12, 192.168/16)", async () => {
    expect(await rejects("http://10.0.0.1/")).toBe(true);
    expect(await rejects("http://172.16.4.4/")).toBe(true);
    expect(await rejects("http://172.31.255.1/")).toBe(true);
    expect(await rejects("https://192.168.1.1/")).toBe(true);
  });

  it("allows public hosts inside the 172.x range that are NOT private", async () => {
    // 172.15 and 172.32 are public — must not be over-blocked.
    expect(await rejects("http://172.15.0.1/")).toBe(false);
    expect(await rejects("http://172.32.0.1/")).toBe(false);
  });

  it("blocks CGNAT, 0.0.0.0/8, multicast and reserved", async () => {
    expect(await rejects("http://100.64.0.1/")).toBe(true);
    expect(await rejects("http://0.0.0.0/")).toBe(true);
    expect(await rejects("http://224.0.0.1/")).toBe(true);
    expect(await rejects("http://240.0.0.1/")).toBe(true);
  });

  it("blocks IPv6 loopback, unique-local, link-local and v4-mapped", async () => {
    expect(await rejects("http://[::1]/")).toBe(true);
    expect(await rejects("http://[fc00::1]/")).toBe(true);
    expect(await rejects("http://[fd12:3456::1]/")).toBe(true);
    expect(await rejects("http://[fe80::1]/")).toBe(true);
    expect(await rejects("http://[::ffff:127.0.0.1]/")).toBe(true);
    expect(await rejects("http://[::ffff:169.254.169.254]/")).toBe(true);
  });

  it("rejects non-http(s) schemes", async () => {
    expect(await rejects("file:///etc/passwd")).toBe(true);
    expect(await rejects("gopher://127.0.0.1/")).toBe(true);
  });

  it("rejects malformed URLs", async () => {
    expect(await rejects("not a url")).toBe(true);
  });

  it("allows a normal public provider host (literal public IP)", async () => {
    // 1.1.1.1 is a public address — should pass classification.
    expect(await rejects("https://1.1.1.1/v1/chat/completions")).toBe(false);
  });
});
