/**
 * Build script for the OSS release of Grepture Proxy.
 *
 * Copies the core proxy source into dist/oss/ excluding:
 *   - plugins/         (proprietary AI actions)
 *   - providers/cloud/  (Supabase/Redis providers)
 *   - infra/            (Supabase/Redis clients)
 *
 * Produces a standalone package that runs with zero external service dependencies.
 *
 * Usage: bun run scripts/build-oss.ts
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const DIST = join(ROOT, "dist", "oss");

// Clean
rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

// Copy source (excluding proprietary code)
cpSync(join(ROOT, "src"), join(DIST, "src"), {
  recursive: true,
  filter: (src) => {
    const rel = src.replace(ROOT + "/", "");
    // Exclude cloud providers and infra clients
    if (rel.includes("src/providers/cloud")) return false;
    if (rel.includes("src/infra")) return false;
    return true;
  },
});

// Copy supporting files
for (const file of ["rules.example.json", "Dockerfile", "README.md", "tsconfig.json"]) {
  try {
    cpSync(join(ROOT, file), join(DIST, file));
  } catch {
    // Optional files
  }
}

// Write OSS-specific package.json (no Supabase, no Redis, no HuggingFace)
const ossPackageJson = {
  name: "grepture-proxy",
  version: readFileSync(join(ROOT, "package.json"), "utf-8")
    .match(/"version":\s*"([^"]+)"/)?.[1] || "0.1.0",
  private: false,
  scripts: {
    dev: "bun run --watch src/index.ts",
    start: "bun run src/index.ts",
  },
  dependencies: {
    hono: "^4.7.0",
  },
  devDependencies: {
    "@types/bun": "^1.2.0",
    typescript: "^5.9.3",
  },
};

writeFileSync(join(DIST, "package.json"), JSON.stringify(ossPackageJson, null, 2) + "\n");

// Rewrite providers/index.ts to only use local providers (no cloud require)
const providersIndex = `import type { AuthProvider, RuleProvider, LogWriter, TokenVault, RateLimiter, QuotaChecker } from "./types";
import { LocalAuthProvider } from "./local/auth";
import { LocalRuleProvider } from "./local/rules";
import { LocalLogWriter } from "./local/log";
import { LocalTokenVault } from "./local/vault";
import { LocalRateLimiter } from "./local/rate-limit";
import { LocalQuotaChecker } from "./local/quota";

export type Providers = {
  auth: AuthProvider;
  rules: RuleProvider;
  log: LogWriter;
  vault: TokenVault;
  rateLimiter: RateLimiter;
  quota: QuotaChecker;
};

let _providers: Providers | null = null;

export function getProviders(): Providers {
  if (_providers) return _providers;

  _providers = {
    auth: new LocalAuthProvider(),
    rules: new LocalRuleProvider(),
    log: new LocalLogWriter(),
    vault: new LocalTokenVault(),
    rateLimiter: new LocalRateLimiter(),
    quota: new LocalQuotaChecker(),
  };

  return _providers;
}
`;

writeFileSync(join(DIST, "src", "providers", "index.ts"), providersIndex);

// Rewrite config.ts to remove cloud env var references
const ossConfig = `export const config = {
  mode: "local" as const,
  plugins: process.env.GREPTURE_PLUGINS ? process.env.GREPTURE_PLUGINS.split(",").map((p) => p.trim()) : [],
  port: parseInt(process.env.PORT || "4001", 10),
  maxBodySize: 10 * 1024 * 1024, // 10MB
} as const;
`;

writeFileSync(join(DIST, "src", "config.ts"), ossConfig);

console.log(`OSS build written to ${DIST}`);
console.log("To test: cd dist/oss && bun install && bun run src/index.ts");
