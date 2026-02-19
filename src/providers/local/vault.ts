import type { TokenVault } from "../types";

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

  async set(teamId: string, token: string, value: string, ttl: number): Promise<void> {
    const key = `${teamId}:${token}`;
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }

  async get(teamId: string, token: string): Promise<string | null> {
    const key = `${teamId}:${token}`;
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
