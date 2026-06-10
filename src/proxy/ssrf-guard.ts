import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Thrown when a forward target is rejected by the SSRF guard. The message is
 * safe to surface to the client (it never echoes resolved internal addresses).
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Decide whether a literal IPv4 address falls in a private/internal range. */
function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true; // malformed → block
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
  return false;
}

/** Decide whether a literal IPv6 address falls in a private/internal range. */
function isBlockedIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true; // unspecified + loopback
  // IPv4-mapped (::ffff:a.b.c.d). The WHATWG URL parser normalizes the dotted
  // quad to hex (::ffff:7f00:1), so handle both forms before checking as v4.
  const mappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mappedDotted) return isBlockedIpv4(mappedDotted[1]);
  const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIpv4(v4);
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
  return false;
}

/** Block a single resolved address; unknown formats are treated as unsafe. */
function isBlockedIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isBlockedIpv4(ip);
  if (kind === 6) return isBlockedIpv6(ip);
  return true;
}

/**
 * Reject forward targets that point at the proxy's own infrastructure.
 *
 * Validates the scheme, then checks every address the hostname resolves to
 * against private / loopback / link-local / metadata ranges. Throws
 * SsrfBlockedError on any violation. Intended for cloud mode only — self-hosted
 * deployments may legitimately proxy to localhost models.
 *
 * Note: a DNS-rebinding attacker can still race the resolution between this
 * check and fetch()'s own lookup. This guard closes direct-IP and
 * internal-hostname access, which covers the practical SSRF surface here.
 */
export async function assertSafeTarget(targetUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new SsrfBlockedError("Invalid target URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrfBlockedError("Target URL must use http or https");
  }

  const host = parsed.hostname;
  // URL wraps IPv6 literals in brackets — strip them before classifying.
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (isIP(literal)) {
    if (isBlockedIp(literal)) {
      throw new SsrfBlockedError("Target resolves to a disallowed address");
    }
    return;
  }

  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    throw new SsrfBlockedError("Target hostname could not be resolved");
  }

  if (addresses.length === 0) {
    throw new SsrfBlockedError("Target hostname did not resolve");
  }
  for (const { address } of addresses) {
    if (isBlockedIp(address)) {
      throw new SsrfBlockedError("Target resolves to a disallowed address");
    }
  }
}
