const mode = (process.env.GREPTURE_MODE || "local") as "local" | "cloud";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function requiredInCloud(name: string): string {
  if (mode === "local") return "";
  return required(name);
}

export const config = {
  mode,
  supabaseUrl: requiredInCloud("SUPABASE_URL"),
  supabaseServiceRoleKey: requiredInCloud("SUPABASE_SERVICE_ROLE_KEY"),
  upstashRedisUrl: requiredInCloud("UPSTASH_REDIS_URL"),
  upstashRedisToken: requiredInCloud("UPSTASH_REDIS_TOKEN"),
  encryptionKey: requiredInCloud("GREPTURE_ENCRYPTION_KEY"),
  plugins: process.env.GREPTURE_PLUGINS ? process.env.GREPTURE_PLUGINS.split(",").map((p) => p.trim()) : [],
  anthropicTarget: process.env.GREPTURE_ANTHROPIC_TARGET || "https://api.anthropic.com",
  openaiTarget: process.env.GREPTURE_OPENAI_TARGET || "https://api.openai.com",
  port: parseInt(process.env.PORT || "4001", 10),
  maxBodySize: 10 * 1024 * 1024, // 10MB

  ai: {
    enabled: process.env.AI_ENABLED === "true",
    nerModel: process.env.AI_NER_MODEL || "Xenova/distilbert-base-multilingual-cased-ner-hrl",
    nerDtype: (process.env.AI_NER_DTYPE || "q8") as "q8" | "fp32" | "fp16",
    injectionModel: process.env.AI_INJECTION_MODEL || "protectai/deberta-v3-base-injection-onnx",
    injectionDtype: (process.env.AI_INJECTION_DTYPE || "fp32") as "q8" | "fp32" | "fp16",
    // Root-level ONNX files need "../model" to escape the default onnx/ subdirectory
    injectionModelFile: process.env.AI_INJECTION_MODEL_FILE || "../model",
    toxicityModel: process.env.AI_TOXICITY_MODEL || "Xenova/toxic-bert",
    toxicityDtype: (process.env.AI_TOXICITY_DTYPE || "q8") as "q8" | "fp32" | "fp16",
    zeroShotModel: process.env.AI_ZERO_SHOT_MODEL || "Xenova/mobilebert-uncased-mnli",
    zeroShotDtype: (process.env.AI_ZERO_SHOT_DTYPE || "q8") as "q8" | "fp32" | "fp16",
  },
} as const;
