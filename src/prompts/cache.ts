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

  // Check if prompt has an active experiment (need to peek at prompt metadata)
  // For explicit version refs, caching is fine
  if (ref) {
    const cacheKey = `grepture:prompt:${teamId}:${slug}:${ref}`;
    try {
      const cached = await redis.get<ResolvedPrompt>(cacheKey);
      if (cached) return cached;
    } catch {
      // Redis down — fall through
    }

    const result = await fetchPromptFromDb(teamId, slug, ref);
    if (!result) return null;

    redis.set(cacheKey, result, { ex: PROMPT_TTL }).catch((err) => {
      console.error("Redis SET prompt failed:", err);
    });

    return result;
  }

  // For "active" resolution, check if experiment is running
  // Cache the prompt metadata separately to avoid DB hit on every request
  const metaCacheKey = `grepture:prompt:${teamId}:${slug}:meta`;
  let hasExperiment = false;

  try {
    const meta = await redis.get<{ experiment: boolean }>(metaCacheKey);
    if (meta !== null) {
      hasExperiment = meta.experiment;
    } else {
      // Peek at prompt to check experiment status
      const { data } = await supabase
        .from("prompts")
        .select("experiment")
        .eq("team_id", teamId)
        .eq("slug", slug)
        .single();
      hasExperiment = !!data?.experiment;
      redis.set(metaCacheKey, { experiment: hasExperiment }, { ex: PROMPT_TTL }).catch(() => {});
    }
  } catch {
    // Redis down — fall through, will check in fetchPromptFromDb
  }

  // If experiment is active, don't cache (each request picks a random variant)
  if (hasExperiment) {
    return fetchPromptFromDb(teamId, slug, ref);
  }

  // Normal path — cache the active version resolution
  const cacheKey = `grepture:prompt:${teamId}:${slug}:active`;
  try {
    const cached = await redis.get<ResolvedPrompt>(cacheKey);
    if (cached) return cached;
  } catch {
    // Redis down — fall through
  }

  const result = await fetchPromptFromDb(teamId, slug, ref);
  if (!result) return null;

  redis.set(cacheKey, result, { ex: PROMPT_TTL }).catch((err) => {
    console.error("Redis SET prompt failed:", err);
  });

  return result;
}

type ExperimentVariant = { version: number; weight: number };
type Experiment = { variants: ExperimentVariant[]; started_at: string; started_by: string };

/**
 * Weighted random selection among experiment variants.
 * Weights should sum to 100.
 */
function pickVariant(variants: ExperimentVariant[]): number {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const v of variants) {
    cumulative += v.weight;
    if (roll < cumulative) return v.version;
  }
  // Fallback to last variant (handles floating point edge cases)
  return variants[variants.length - 1].version;
}

async function fetchPromptFromDb(
  teamId: string,
  slug: string,
  ref?: string,
): Promise<ResolvedPrompt | null> {
  // Fetch prompt by slug (including experiment config)
  const { data: prompt, error } = await supabase
    .from("prompts")
    .select("id, team_id, slug, name, skip_rules, active_version, experiment")
    .eq("team_id", teamId)
    .eq("slug", slug)
    .single();

  if (error || !prompt) return null;

  // Determine which version to resolve
  let targetVersion: number | null = null;

  if (ref === "draft") {
    // Explicit draft request — handled below
  } else if (ref && /^\d+$/.test(ref)) {
    // Explicit version number
    targetVersion = parseInt(ref, 10);
  } else if (prompt.experiment) {
    // A/B experiment is running — pick a variant by weight
    const experiment = prompt.experiment as Experiment;
    if (experiment.variants?.length >= 2) {
      targetVersion = pickVariant(experiment.variants);
    }
  }

  // Fall back to active_version if no experiment or explicit ref
  if (targetVersion === null && ref !== "draft") {
    targetVersion = prompt.active_version ?? null;
  }

  // Resolve version
  let versionQuery = supabase
    .from("prompt_versions")
    .select("id, prompt_id, version, messages, variables, published_at")
    .eq("prompt_id", prompt.id);

  if (ref === "draft") {
    versionQuery = versionQuery.is("version", null);
  } else if (targetVersion !== null) {
    versionQuery = versionQuery.eq("version", targetVersion);
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
