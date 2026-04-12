/**
 * Test provider implementations for injection via setProviders().
 */
import type { Providers } from "../../src/providers";
import type {
  AuthProvider,
  RuleProvider,
  LogWriter,
  TokenVault,
  RateLimiter,
  QuotaChecker,
  RateQuotaChecker,
  ProviderKeyResolver,
  ResolvedProviderKey,
} from "../../src/providers/types";
import type { AuthInfo, Rule, TrafficLogEntry } from "../../src/types";

// ─── Test provider key resolver ────────────────────────────────────────────

export class TestProviderKeyResolver implements ProviderKeyResolver {
  private keys: ResolvedProviderKey[];

  constructor(keys: ResolvedProviderKey[]) {
    this.keys = keys;
  }

  async resolve(_teamId: string, provider: string): Promise<ResolvedProviderKey | null> {
    return this.keys.find((k) => k.provider === provider) ?? null;
  }

  async resolveById(keyId: string): Promise<ResolvedProviderKey | null> {
    return this.keys.find((k) => k.id === keyId) ?? null;
  }

  async resolveChain(
    _teamId: string,
    provider: string,
    _maxHops?: number,
  ): Promise<ResolvedProviderKey[]> {
    // Return the full chain starting from the primary key for this provider
    const primary = this.keys.find((k) => k.provider === provider);
    if (!primary) return [];

    const chain: ResolvedProviderKey[] = [primary];
    let current = primary;
    const seen = new Set<string>([current.id]);

    while (current.fallback_key_id) {
      const next = this.keys.find((k) => k.id === current.fallback_key_id);
      if (!next || seen.has(next.id)) break;
      seen.add(next.id);
      chain.push(next);
      current = next;
    }

    return chain;
  }
}

// ─── Stub implementations ──────────────────────────────────────────────────

class StubAuth implements AuthProvider {
  async authenticate(_apiKey: string): Promise<AuthInfo | null> {
    return {
      team_id: "test-team",
      user_id: "test-user",
      tier: "free",
      fallback_mode: "block",
      zero_data_mode: false,
    } as AuthInfo;
  }
}

class StubRules implements RuleProvider {
  async loadRules(_teamId: string): Promise<Rule[]> {
    return [];
  }
}

class StubLog implements LogWriter {
  entries: TrafficLogEntry[] = [];
  push(entry: TrafficLogEntry): void {
    this.entries.push(entry);
  }
  async flush(): Promise<void> {}
}

class StubVault implements TokenVault {
  private store = new Map<string, string>();
  async set(_teamId: string, token: string, value: string, _ttl: number): Promise<void> {
    this.store.set(token, value);
  }
  async get(_teamId: string, token: string): Promise<string | null> {
    return this.store.get(token) ?? null;
  }
}

class StubRateLimiter implements RateLimiter {
  async check(_teamId: string, _tier: string) {
    return { allowed: true };
  }
}

class StubQuota implements QuotaChecker {
  async check(_teamId: string, _tier: string) {
    return { allowed: true };
  }
  async checkAiSampling(_teamId: string, _tier: string) {
    return { allowed: true, used: 0, limit: Infinity };
  }
}

class StubRateQuota implements RateQuotaChecker {
  async check(_teamId: string, _tier: string) {
    return {
      rate: { allowed: true },
      quota: { allowed: true },
    };
  }
  async checkAiSampling(_teamId: string, _tier: string) {
    return { allowed: true, used: 0, limit: Infinity };
  }
}

// ─── Factory ───────────────────────────────────────────────────────────────

export function createTestProviders(keys: ResolvedProviderKey[] = []): Providers {
  return {
    auth: new StubAuth(),
    rules: new StubRules(),
    log: new StubLog(),
    vault: new StubVault(),
    rateLimiter: new StubRateLimiter(),
    quota: new StubQuota(),
    rateQuota: new StubRateQuota(),
    providerKeys: new TestProviderKeyResolver(keys),
  };
}
