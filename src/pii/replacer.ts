import type { PiiCategory, AiPiiCategory } from "../types";
import type { PiiMatch } from "./detector";

type ReplacementStrategy = "placeholder" | "hash" | "mask";

const placeholders: Record<PiiCategory | AiPiiCategory, string> = {
  email: "[EMAIL_REDACTED]",
  phone: "[PHONE_REDACTED]",
  ssn: "[SSN_REDACTED]",
  credit_card: "[CREDIT_CARD_REDACTED]",
  ip_address: "[IP_REDACTED]",
  address: "[ADDRESS_REDACTED]",
  name: "[NAME_REDACTED]",
  date_of_birth: "[DOB_REDACTED]",
  person: "[PERSON_REDACTED]",
  location: "[LOCATION_REDACTED]",
  organization: "[ORGANIZATION_REDACTED]",
};

async function hashValue(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

function maskValue(value: string): string {
  if (value.length <= 2) return "**";
  if (value.length <= 4) return value[0] + "***";
  return value[0] + "*".repeat(value.length - 2) + value[value.length - 1];
}

function getPlaceholder(match: PiiMatch): string {
  return placeholders[match.category] || "[REDACTED]";
}

export async function replacePii(
  text: string,
  matches: PiiMatch[],
  strategy: ReplacementStrategy,
): Promise<string> {
  if (matches.length === 0) return text;

  // Build replacements (may need async for hash)
  const replacements: string[] = [];
  for (const m of matches) {
    switch (strategy) {
      case "placeholder":
        replacements.push(getPlaceholder(m));
        break;
      case "hash":
        replacements.push(await hashValue(m.match));
        break;
      case "mask":
        replacements.push(maskValue(m.match));
        break;
    }
  }

  // Replace right-to-left to preserve indices
  let result = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    result = result.slice(0, matches[i].start) + replacements[i] + result.slice(matches[i].end);
  }

  return result;
}
