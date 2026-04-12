// Supported provider request/response formats. Only chat-completion-shaped APIs.
export type Format = "openai" | "anthropic";

/**
 * Thrown when a request cannot be translated to the target format
 * (e.g., it uses tool calls or other unsupported features). The fallback
 * loop catches this and skips the offending key, moving to the next.
 */
export class TranslationNotSupportedError extends Error {
  constructor(public readonly reason: string) {
    super(`Translation not supported: ${reason}`);
    this.name = "TranslationNotSupportedError";
  }
}
