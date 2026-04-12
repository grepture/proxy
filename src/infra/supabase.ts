import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config";

let _client: SupabaseClient | null = null;

/** Lazy-initialized Supabase client — avoids crash in local/test mode. */
export function getSupabase(): SupabaseClient {
  if (!_client) {
    _client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  }
  return _client;
}

/** @deprecated Use getSupabase() — kept for backwards compat with existing imports. */
export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop) {
    return (getSupabase() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
