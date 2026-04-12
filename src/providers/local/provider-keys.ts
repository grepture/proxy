import type { ProviderKeyResolver, ResolvedProviderKey } from "../types";

/**
 * Local-mode resolver: provider keys are not stored. Users must pass
 * X-Grepture-Auth-Forward on every request, just like before this feature existed.
 */
export class LocalProviderKeyResolver implements ProviderKeyResolver {
  async resolve(_teamId: string, _provider: string): Promise<ResolvedProviderKey | null> {
    return null;
  }

  async resolveById(_keyId: string): Promise<ResolvedProviderKey | null> {
    return null;
  }

  async resolveChain(
    _teamId: string,
    _provider: string,
    _maxHops?: number,
  ): Promise<ResolvedProviderKey[]> {
    return [];
  }
}
