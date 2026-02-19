import { redis } from "../../infra/redis";
import { supabase } from "../../infra/supabase";
import type { AuthProvider } from "../types";
import type { AuthInfo } from "../../types";

const AUTH_TTL = 60; // seconds

async function sha256(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export class CloudAuthProvider implements AuthProvider {
  async authenticate(apiKey: string): Promise<AuthInfo | null> {
    const hash = await sha256(apiKey);
    const cacheKey = `grepture:auth:${hash}`;

    // Check Redis cache
    try {
      const cached = await redis.get<AuthInfo>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis down — fall through to Supabase
    }

    // Supabase fallback
    const { data, error } = await supabase
      .from("api_settings")
      .select("team_id, user_id, fallback_mode, zero_data_mode")
      .eq("api_key", apiKey)
      .single();

    if (error || !data) return null;

    // Resolve subscription tier
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("tier")
      .eq("team_id", data.team_id)
      .in("status", ["active", "trialing"])
      .limit(1)
      .single();

    const info: AuthInfo = {
      team_id: data.team_id,
      user_id: data.user_id,
      fallback_mode: data.fallback_mode,
      zero_data_mode: data.zero_data_mode,
      tier: (sub?.tier as string) ?? "free",
    };

    // Cache (fire-and-forget)
    redis.set(cacheKey, info, { ex: AUTH_TTL }).catch((err) => {
      console.error("Redis SET auth failed:", err);
    });

    return info;
  }
}
