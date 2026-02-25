/**
 * Proxy latency benchmark
 *
 * Measures the overhead added by the Grepture proxy by comparing
 * direct requests to a target API vs requests routed through the proxy.
 * Supports both OpenAI and Anthropic APIs.
 *
 * Requests are interleaved (direct, proxied, direct, proxied, ...) to
 * minimize variance from fluctuating API response times.
 *
 * Usage:
 *   GREPTURE_API_KEY=gpt_xxx OPENAI_API_KEY=sk-xxx ANTHROPIC_API_KEY=sk-ant-xxx \
 *     bun run scripts/bench-latency.ts
 *
 * Options (env vars):
 *   GREPTURE_API_KEY   — Grepture proxy API key (required)
 *   OPENAI_API_KEY     — OpenAI API key (optional, skips if missing)
 *   ANTHROPIC_API_KEY  — Anthropic API key (optional, skips if missing)
 *   PROXY_URL          — Proxy base URL (default: http://localhost:4001)
 *   REQUESTS           — Number of request pairs (default: 10)
 */

const PROXY_URL = process.env.PROXY_URL || "https://proxy.grepture.com";
const GREPTURE_API_KEY = process.env.GREPTURE_API_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const REQUESTS = parseInt(process.env.REQUESTS || "10", 10);

if (!GREPTURE_API_KEY) {
  console.error("Missing GREPTURE_API_KEY environment variable");
  process.exit(1);
}

if (!OPENAI_API_KEY && !ANTHROPIC_API_KEY) {
  console.error(
    "Provide at least one of OPENAI_API_KEY or ANTHROPIC_API_KEY",
  );
  process.exit(1);
}

// --- Provider definitions ---

type Provider = {
  name: string;
  targetUrl: string;
  apiKey: string;
  model: string;
  buildHeaders: () => Record<string, string>;
  buildBody: () => string;
};

const providers: Provider[] = [];

if (OPENAI_API_KEY) {
  providers.push({
    name: "OpenAI",
    targetUrl: "https://api.openai.com/v1/chat/completions",
    apiKey: OPENAI_API_KEY,
    model: "gpt-4o-mini",
    buildHeaders() {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      };
    },
    buildBody() {
      return JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: "Say 'ok'" }],
        max_tokens: 3,
      });
    },
  });
}

if (ANTHROPIC_API_KEY) {
  providers.push({
    name: "Anthropic",
    targetUrl: "https://api.anthropic.com/v1/messages",
    apiKey: ANTHROPIC_API_KEY,
    model: "claude-haiku-4-5-20251001",
    buildHeaders() {
      return {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      };
    },
    buildBody() {
      return JSON.stringify({
        model: this.model,
        messages: [{ role: "user", content: "Say 'ok'" }],
        max_tokens: 3,
      });
    },
  });
}

// --- Timing ---

type TimingResult = {
  latencyMs: number;
  status: number;
  ok: boolean;
};

async function directRequest(provider: Provider): Promise<TimingResult> {
  const start = performance.now();
  const res = await fetch(provider.targetUrl, {
    method: "POST",
    headers: provider.buildHeaders(),
    body: provider.buildBody(),
  });
  await res.text();
  return {
    latencyMs: performance.now() - start,
    status: res.status,
    ok: res.ok,
  };
}

async function proxiedRequest(provider: Provider): Promise<TimingResult> {
  const parsed = new URL(provider.targetUrl);
  const proxyRequestUrl = `${PROXY_URL}/proxy${parsed.pathname}${parsed.search}`;

  // Start with all provider headers (anthropic-version, content-type, etc.)
  const providerHeaders = provider.buildHeaders();
  const authForward =
    providerHeaders["Authorization"] ||
    (providerHeaders["x-api-key"]
      ? `Bearer ${providerHeaders["x-api-key"]}`
      : "");

  // Remove auth headers — they'll be replaced with Grepture auth
  delete providerHeaders["Authorization"];
  delete providerHeaders["x-api-key"];

  const start = performance.now();
  const res = await fetch(proxyRequestUrl, {
    method: "POST",
    headers: {
      ...providerHeaders,
      Authorization: `Bearer ${GREPTURE_API_KEY}`,
      "X-Grepture-Target": provider.targetUrl,
      "X-Grepture-Auth-Forward": authForward,
    },
    body: provider.buildBody(),
  });
  await res.text();
  return {
    latencyMs: performance.now() - start,
    status: res.status,
    ok: res.ok,
  };
}

// --- Stats ---

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function stats(results: TimingResult[]) {
  const ok = results.filter((r) => r.ok);
  const latencies = ok.map((r) => r.latencyMs).sort((a, b) => a - b);
  const failed = results.filter((r) => !r.ok);
  return {
    count: results.length,
    okCount: ok.length,
    failed,
    min: latencies[0] ?? 0,
    max: latencies[latencies.length - 1] ?? 0,
    avg: latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0,
    p50: latencies.length > 0 ? percentile(latencies, 50) : 0,
    p95: latencies.length > 0 ? percentile(latencies, 95) : 0,
    p99: latencies.length > 0 ? percentile(latencies, 99) : 0,
  };
}

function fmt(ms: number): string {
  return ms.toFixed(0).padStart(6) + "ms";
}

function printStats(label: string, s: ReturnType<typeof stats>) {
  console.log(
    `\n  ${label} (${s.okCount}/${s.count} ok)`,
  );
  if (s.failed.length > 0) {
    const codes = s.failed.map((r) => r.status);
    const counts: Record<number, number> = {};
    for (const c of codes) counts[c] = (counts[c] || 0) + 1;
    const summary = Object.entries(counts)
      .map(([code, n]) => `${code}x${n}`)
      .join(", ");
    console.log(`    errors: ${summary}`);
  }
  if (s.okCount === 0) {
    console.log("    no successful requests — skipping stats");
    return;
  }
  console.log(
    `    min ${fmt(s.min)}   avg ${fmt(s.avg)}   max ${fmt(s.max)}`,
  );
  console.log(
    `    p50 ${fmt(s.p50)}   p95 ${fmt(s.p95)}   p99 ${fmt(s.p99)}`,
  );
}

// --- Main ---

async function benchProvider(provider: Provider) {
  console.log(`\n========== ${provider.name} (${provider.model}) ==========`);
  console.log(`  Target: ${provider.targetUrl}`);

  // Warmup
  console.log("  Warming up...");
  await directRequest(provider).catch(() => {});
  await proxiedRequest(provider).catch(() => {});

  // Interleaved requests to minimize variance from API fluctuations
  console.log(`  Running ${REQUESTS} interleaved pairs...`);
  const directResults: TimingResult[] = [];
  const proxiedResults: TimingResult[] = [];

  for (let i = 0; i < REQUESTS; i++) {
    const d = await directRequest(provider);
    const p = await proxiedRequest(provider);
    directResults.push(d);
    proxiedResults.push(p);

    const dTag = d.ok ? `${d.latencyMs.toFixed(0)}ms` : `ERR ${d.status}`;
    const pTag = p.ok ? `${p.latencyMs.toFixed(0)}ms` : `ERR ${p.status}`;
    const delta = p.ok && d.ok
      ? `${(p.latencyMs - d.latencyMs >= 0 ? "+" : "")}${(p.latencyMs - d.latencyMs).toFixed(0)}ms`
      : "—";
    console.log(
      `    ${String(i + 1).padStart(3)}  direct: ${dTag.padStart(7)}  proxied: ${pTag.padStart(7)}  delta: ${delta}`,
    );
  }

  const directStats = stats(directResults);
  const proxiedStats = stats(proxiedResults);

  printStats("Direct", directStats);
  printStats("Proxied", proxiedStats);

  if (directStats.okCount > 0 && proxiedStats.okCount > 0) {
    const overhead = proxiedStats.avg - directStats.avg;
    const overheadPct = (overhead / directStats.avg) * 100;
    console.log(`\n  Proxy overhead`);
    console.log(
      `    avg  ${overhead >= 0 ? "+" : ""}${fmt(overhead)} (${overheadPct >= 0 ? "+" : ""}${overheadPct.toFixed(1)}%)`,
    );
    console.log(`    p50  ${fmt(proxiedStats.p50 - directStats.p50)}`);
    console.log(`    p95  ${fmt(proxiedStats.p95 - directStats.p95)}`);
  }
}

async function main() {
  console.log("Proxy latency benchmark");
  console.log(`  Proxy:       ${PROXY_URL}`);
  console.log(`  Requests:    ${REQUESTS} pairs per provider`);
  console.log(
    `  Providers:   ${providers.map((p) => p.name).join(", ")}`,
  );

  for (const provider of providers) {
    await benchProvider(provider);
  }

  console.log("\nDone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
