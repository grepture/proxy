import { config } from "../config";
import type { AuthProvider, RuleProvider, LogWriter, TokenVault, RateLimiter, QuotaChecker, RateQuotaChecker, ProviderKeyResolver } from "./types";

export type Providers = {
  auth: AuthProvider;
  rules: RuleProvider;
  log: LogWriter;
  vault: TokenVault;
  rateLimiter: RateLimiter;
  quota: QuotaChecker;
  rateQuota: RateQuotaChecker;
  providerKeys: ProviderKeyResolver;
};

let _providers: Providers | null = null;

/** Inject providers for testing. Bypasses the mode-based factory. */
export function setProviders(p: Providers): void {
  _providers = p;
}

/** Reset to force re-initialization on next getProviders() call. */
export function resetProviders(): void {
  _providers = null;
}

export function getProviders(): Providers {
  if (_providers) return _providers;

  if (config.mode === "cloud") {
    // Dynamic imports would be cleaner, but these are small modules — eagerly load
    const { CloudAuthProvider } = require("./cloud/auth");
    const { CloudRuleProvider } = require("./cloud/rules");
    const { CloudLogWriter } = require("./cloud/log");
    const { CloudTokenVault } = require("./cloud/vault");
    const { CloudRateLimiter } = require("./cloud/rate-limit");
    const { CloudQuotaChecker } = require("./cloud/quota");
    const { CloudRateQuotaChecker } = require("./cloud/rate-quota");
    const { CloudProviderKeyResolver } = require("./cloud/provider-keys");

    _providers = {
      auth: new CloudAuthProvider(),
      rules: new CloudRuleProvider(),
      log: new CloudLogWriter(),
      vault: new CloudTokenVault(),
      rateLimiter: new CloudRateLimiter(),
      quota: new CloudQuotaChecker(),
      rateQuota: new CloudRateQuotaChecker(),
      providerKeys: new CloudProviderKeyResolver(),
    };
  } else {
    const { LocalAuthProvider } = require("./local/auth");
    const { LocalRuleProvider } = require("./local/rules");
    const { LocalLogWriter } = require("./local/log");
    const { LocalTokenVault } = require("./local/vault");
    const { LocalRateLimiter } = require("./local/rate-limit");
    const { LocalQuotaChecker } = require("./local/quota");
    const { LocalRateQuotaChecker } = require("./local/rate-quota");
    const { LocalProviderKeyResolver } = require("./local/provider-keys");

    _providers = {
      auth: new LocalAuthProvider(),
      rules: new LocalRuleProvider(),
      log: new LocalLogWriter(),
      vault: new LocalTokenVault(),
      rateLimiter: new LocalRateLimiter(),
      quota: new LocalQuotaChecker(),
      rateQuota: new LocalRateQuotaChecker(),
      providerKeys: new LocalProviderKeyResolver(),
    };
  }

  return _providers;
}
