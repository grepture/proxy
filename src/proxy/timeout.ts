/**
 * Parses X-Grepture-Timeout: a whole number of seconds that replaces the
 * applied rules' timeouts for one request. Returns null when absent, or an
 * error message when invalid.
 */
export function parseTimeoutHeader(value: string | undefined): { seconds: number } | { error: string } | null {
  if (value === undefined || value.trim() === "") return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    return { error: "Invalid X-Grepture-Timeout: expected a whole number of seconds (1 or more)" };
  }
  return { seconds: Number(trimmed) };
}

/**
 * How long to wait on the upstream. An explicit per-request timeout wins over
 * rule timeouts; otherwise the shortest applied rule wins. Both are capped at
 * the server maximum.
 */
export function resolveTimeoutMs(ruleTimeoutsSeconds: number[], requestedSeconds: number | null, maxSeconds: number): number {
  const seconds = requestedSeconds ?? Math.min(...ruleTimeoutsSeconds, maxSeconds);
  return Math.min(seconds, maxSeconds) * 1000;
}
