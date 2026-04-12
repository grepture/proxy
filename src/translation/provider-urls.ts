import { config } from "../config";
import type { Format } from "./types";

/**
 * Resolve the full target URL for a provider's chat-completion endpoint.
 * Reuses the existing config base URLs from proxy/src/config.ts so users
 * can still override them via env vars (GREPTURE_OPENAI_TARGET, GREPTURE_ANTHROPIC_TARGET).
 */
export function providerUrl(provider: Format): string {
  if (provider === "openai") return `${config.openaiTarget}/v1/chat/completions`;
  if (provider === "anthropic") return `${config.anthropicTarget}/v1/messages`;
  throw new Error(`Unknown provider for URL resolution: ${provider as string}`);
}
