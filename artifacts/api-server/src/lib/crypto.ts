/**
 * Symmetric encryption for sensitive stored values (AES-256-GCM).
 *
 * Key source: ENCRYPTION_SECRET env var (must be set; no insecure fallback).
 * When ENCRYPTION_SECRET is not configured, all encrypt/decrypt calls throw
 * so callers can surface a clear error rather than silently using a weak key.
 *
 * Each encrypted value is stored as a versioned string:
 *   enc:v1:<iv-base64>.<auth-tag-base64>.<ciphertext-base64>
 *
 * The "enc:v1:" prefix provides unambiguous detection so that plaintext values
 * containing dots (e.g. email addresses, GHIN API keys with dots) are never
 * misidentified as encrypted.
 */

import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const ALG = "aes-256-gcm";
const PREFIX = "enc:v1:";

/**
 * Whether the encryption key is available.
 * Use this before attempting to store or load encrypted values so the
 * API layer can return a clear 503/400 instead of a raw exception.
 */
export function encryptionAvailable(): boolean {
  return !!process.env.ENCRYPTION_SECRET;
}

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) {
    throw new Error(
      "ENCRYPTION_SECRET environment variable is not set. " +
      "Configure it to enable secure GHIN credential storage."
    );
  }
  return createHash("sha256").update(secret).digest();
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
}

export function decrypt(ciphertext: string): string {
  if (!ciphertext.startsWith(PREFIX)) throw new Error("Not an encrypted value (missing enc:v1: prefix)");
  const inner = ciphertext.slice(PREFIX.length);
  const parts = inner.split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted value format");
  const [ivB64, tagB64, ctB64] = parts;
  const key = getKey();
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Returns true if the string was produced by encrypt() (has enc:v1: prefix). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}
