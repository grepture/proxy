import { config } from "../config";
import type { AuthProvider, RuleProvider, LogWriter, TokenVault, RateLimiter, QuotaChecker } from "./types";

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

  if (config.mode === "cloud") {
    // Dynamic imports would be cleaner, but these are small modules — eagerly load
    const { CloudAuthProvider } = require("./cloud/auth");
    const { CloudRuleProvider } = require("./cloud/rules");
    const { CloudLogWriter } = require("./cloud/log");
    const { CloudTokenVault } = require("./cloud/vault");
    const { CloudRateLimiter } = require("./cloud/rate-limit");
    const { CloudQuotaChecker } = require("./cloud/quota");

    _providers = {
      auth: new CloudAuthProvider(),
      rules: new CloudRuleProvider(),
      log: new CloudLogWriter(),
      vault: new CloudTokenVault(),
      rateLimiter: new CloudRateLimiter(),
      quota: new CloudQuotaChecker(),
    };
  } else {
    const { LocalAuthProvider } = require("./local/auth");
    const { LocalRuleProvider } = require("./local/rules");
    const { LocalLogWriter } = require("./local/log");
    const { LocalTokenVault } = require("./local/vault");
    const { LocalRateLimiter } = require("./local/rate-limit");
    const { LocalQuotaChecker } = require("./local/quota");

    _providers = {
      auth: new LocalAuthProvider(),
      rules: new LocalRuleProvider(),
      log: new LocalLogWriter(),
      vault: new LocalTokenVault(),
      rateLimiter: new LocalRateLimiter(),
      quota: new LocalQuotaChecker(),
    };
  }

  return _providers;
}
