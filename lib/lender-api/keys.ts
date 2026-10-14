import { createHash, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * API key format: `cfk_<prefix>_<secret>`.
 *   prefix: 12 lowercase hex chars, stored in clear (ApiKey.prefix, unique) and
 *           shown in Settings so a lender can tell keys apart;
 *   secret: 32 random bytes, base64url (43 chars). Never stored.
 * The row keeps SHA-256 of the whole key. A 256-bit random secret needs no
 * slow hash: there is nothing to brute-force from the digest.
 */
const KEY_PATTERN = /^cfk_([0-9a-f]{12})_([A-Za-z0-9_-]{43})$/

export interface GeneratedApiKey {
  /** The full key. Shown once, then gone. */
  key: string
  prefix: string
  keyHash: string
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex")
}

export function generateApiKey(): GeneratedApiKey {
  const prefix = randomBytes(6).toString("hex")
  const key = `cfk_${prefix}_${randomBytes(32).toString("base64url")}`
  return { key, prefix, keyHash: hashApiKey(key) }
}

/** The prefix of a well-formed key, or null. */
export function apiKeyPrefix(key: string): string | null {
  return KEY_PATTERN.exec(key)?.[1] ?? null
}

/** The bearer token from an Authorization header, or null. */
export function bearerToken(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "")
  return match ? match[1] : null
}

export function apiKeyMatches(key: string, storedHash: string): boolean {
  const given = Buffer.from(hashApiKey(key), "hex")
  const stored = Buffer.from(storedHash, "hex")
  return given.length === stored.length && timingSafeEqual(given, stored)
}

export type ApiKeyState = "active" | "revoked" | "expired"

export function apiKeyState(row: { revokedAt: Date | null; expiresAt: Date }, now: Date = new Date()): ApiKeyState {
  if (row.revokedAt) return "revoked"
  if (row.expiresAt.getTime() <= now.getTime()) return "expired"
  return "active"
}

/** Lifetimes a lender can choose when creating a key. */
export const API_KEY_LIFETIME_DAYS = [30, 90, 180, 365] as const

export function isApiKeyLifetime(value: unknown): value is (typeof API_KEY_LIFETIME_DAYS)[number] {
  return typeof value === "number" && (API_KEY_LIFETIME_DAYS as readonly number[]).includes(value)
}
