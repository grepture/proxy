/**
 * Parse a W3C traceparent header (https://www.w3.org/TR/trace-context/).
 *
 * Format: version "-" trace-id "-" parent-id "-" trace-flags
 * Example: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
 */
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

export function parseTraceparent(
  header: string | undefined,
): { traceId: string; spanId: string } | null {
  if (!header) return null;
  const match = TRACEPARENT_RE.exec(header.trim());
  if (!match) return null;
  const [, version, traceId, spanId] = match;
  // Version ff and all-zero ids are invalid per spec
  if (version === "ff") return null;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) return null;
  return { traceId, spanId };
}
