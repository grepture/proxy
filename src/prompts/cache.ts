import { redis } from "../infra/redis";
import { supabase } from "../infra/supabase";
import type { PromptRecord, PromptVersionRecord, PromptMessage, PromptVariable } from "../types";

const PROMPT_TTL = 60; // 1 minute — shorter than rules since prompts change more often

type ResolvedPrompt = {
  prompt: PromptRecord;
  version: PromptVersionRecord;
};

/**
 * Fetch a prompt by slug + optional version ref.
 * ref: undefined = active version, "draft" = draft, number = specific version
 */
export async function fetchPrompt(
  teamId: string,
  slug: string,
  ref?: string,
): Promise<ResolvedPrompt | null> {
  // Always go to DB for draft requests (no caching)
  if (ref === "draft") {
    return fetchPromptFromDb(teamId, slug, ref);
  }

  const cacheKey = `grepture:prompt:${teamId}:${slug}:${ref ?? "active"}`;

  // Try cache
  try {
    const cached = await redis.get<ResolvedPrompt>(cacheKey);
    if (cached) return cached;
  } catch {
    // Redis down — fall through
  }

  const result = await fetchPromptFromDb(teamId, slug, ref);
  if (!result) return null;

  // Cache (fire-and-forget)
  redis.set(cacheKey, result, { ex: PROMPT_TTL }).catch((err) => {
    console.error("Redis SET prompt failed:", err);
  });

  return result;
}

async function fetchPromptFromDb(
  teamId: string,
  slug: string,
  ref?: string,
): Promise<ResolvedPrompt | null> {
  // Fetch prompt by slug
  const { data: prompt, error } = await supabase
    .from("prompts")
    .select("id, team_id, slug, name, skip_rules, active_version")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .single();

  if (error || !prompt) return null;

  // Resolve version
  let versionQuery = supabase
    .from("prompt_versions")
    .select("id, prompt_id, version, messages, variables, published_at")
    .eq("prompt_id", prompt.id);

  if (ref === "draft") {
    versionQuery = versionQuery.is("version", null);
  } else if (ref && /^\d+$/.test(ref)) {
    versionQuery = versionQuery.eq("version", parseInt(ref, 10));
  } else if (prompt.active_version) {
    versionQuery = versionQuery.eq("version", prompt.active_version);
  } else {
    // No active version — try draft
    versionQuery = versionQuery.is("version", null);
  }

  const { data: version } = await versionQuery.single();
  if (!version) return null;

  return {
    prompt: prompt as PromptRecord,
    version: version as PromptVersionRecord,
  };
}

export function invalidatePromptCache(teamId: string, slug: string): Promise<unknown> {
  // Delete all cached versions for this prompt
  // Since we can't pattern-delete in Upstash easily, delete common keys
  return Promise.all([
    redis.del(`grepture:prompt:${teamId}:${slug}:active`),
  ]).catch((err) => {
    console.error("Failed to invalidate prompt cache:", err);
  });
}
