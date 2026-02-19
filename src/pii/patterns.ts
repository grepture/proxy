import type { PiiCategory } from "../types";

export const piiPatterns: Record<PiiCategory, RegExp[]> = {
  email: [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g],

  phone: [
    // US format
    /(\+1)?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
    // International
    /\+\d{1,3}[\s.-]?\d{4,14}/g,
  ],

  ssn: [/\b\d{3}-\d{2}-\d{4}\b/g],

  credit_card: [
    // Visa
    /\b4\d{3}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    // Mastercard
    /\b5[1-5]\d{2}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
    // Amex
    /\b3[47]\d{2}[\s-]?\d{6}[\s-]?\d{5}\b/g,
    // Discover
    /\b6(?:011|5\d{2})[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  ],

  ip_address: [/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g],

  address: [
    /\b\d{1,5}\s+\w+\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Place|Pl|Way|Circle|Cir)\b/gi,
  ],

  name: [], // Skip for v1 — regex-based name detection too unreliable

  date_of_birth: [
    // Numeric formats: 01/15/1990, 01-15-1990
    /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g,
    // Written months: January 15, 1990
    /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{2,4}\b/gi,
  ],
};
