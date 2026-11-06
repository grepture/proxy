import type { TokenVault } from "../types";
import { vaultKey } from "../vault-key";

type VaultEntry = { value: string; expiresAt: number };

export class LocalTokenVault implements TokenVault {
  private store = new Map<string, VaultEntry>();
  private cleanupTimer: ReturnType<typeof setInterval>;

  constructor() {
    // Lazy cleanup every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    // Don't keep the process alive just for cleanup
    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  async set(teamId: string, token: string, value: string, ttl: number, scope: string | null = null): Promise<void> {
    this.store.set(vaultKey(teamId, token, scope), { value, expiresAt: Date.now() + ttl * 1000 });
  }

  async get(teamId: string, token: string, scope: string | null = null): Promise<string | null> {
    if (!scope) return this.read(vaultKey(teamId, token, null));
    return this.read(vaultKey(teamId, token, scope)) ?? this.read(vaultKey(teamId, token, null));
  }

  private read(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }
}
