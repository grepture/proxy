export type ScanCheck = "pii" | "ai_pii" | "toxicity" | "injection" | "dlp" | "compliance";

export type ScanRequest = {
  text: string;
  checks: ScanCheck[];
};

export type PiiResult = {
  matches: Array<{ category: string; match: string; start: number; end: number }>;
};

export type ClassificationResult = {
  detected: boolean;
  matched_categories: Array<{ category: string; score: number }>;
};

export type SkippedResult = {
  skipped: true;
  reason: "requires_pro" | "requires_business" | "ai_quota_exceeded" | "no_matching_rule";
};

export type ScanCheckResult = PiiResult | ClassificationResult | SkippedResult;

export type ScanResponse = {
  results: Record<string, ScanCheckResult>;
  tier: string;
  checks_run: string[];
  checks_skipped: string[];
};

export type ScanFilesRequest = {
  files: Array<{ path: string; text: string }>;
  checks: ScanCheck[];
};

export type ScanFileResult = {
  path: string;
  results: Record<string, ScanCheckResult>;
  skipped?: string;
};

export type ScanFilesResponse = {
  files: ScanFileResult[];
  tier: string;
  checks_run: string[];
  checks_skipped: Array<{ check: string; reason: string }>;
};

export type AccountResponse = {
  tier: string;
  team_id: string;
  checks_available: ScanCheck[];
  checks_unavailable: ScanCheck[];
};
