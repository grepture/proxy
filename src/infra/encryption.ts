import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";
import { config } from "../config";

// AES-256-GCM authenticated encryption for provider API keys.
// Master key is derived from GREPTURE_ENCRYPTION_KEY env var via SHA-256.
// Format: base64(iv || ciphertext || authTag)

const IV_LENGTH = 12;   // GCM standard
const TAG_LENGTH = 16;

function deriveKey(): Buffer {
  if (!config.encryptionKey) {
    throw new Error("GREPTURE_ENCRYPTION_KEY is not set (required in cloud mode)");
  }
  return createHash("sha256").update(config.encryptionKey).digest();
}

export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, tag]).toString("base64");
}

export function decrypt(encoded: string): string {
  const key = deriveKey();
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Invalid encrypted payload: too short");
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(buf.length - TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
