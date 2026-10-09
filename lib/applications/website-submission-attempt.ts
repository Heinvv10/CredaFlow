const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/

export const WEBSITE_SUBMISSION_ATTEMPT_STORAGE_KEY =
  "lms:website-application-submission:v1"

export type WebsiteSubmissionAttempt = {
  fingerprint: string
  key: string
}

export function parseStoredWebsiteSubmissionAttempt(
  raw: string | null,
): WebsiteSubmissionAttempt | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<WebsiteSubmissionAttempt>
    if (
      typeof value.fingerprint !== "string" ||
      !SHA256_PATTERN.test(value.fingerprint) ||
      typeof value.key !== "string" ||
      !UUID_PATTERN.test(value.key)
    ) {
      return null
    }
    return {
      fingerprint: value.fingerprint,
      key: value.key.toLowerCase(),
    }
  } catch {
    return null
  }
}

export async function fingerprintWebsiteSubmissionMaterial(
  material: unknown,
): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(material))
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("")
}

export function createWebsiteSubmissionKey(): string {
  if (typeof globalThis.crypto.randomUUID === "function") {
    return globalThis.crypto.randomUUID()
  }

  // randomUUID is absent in a few otherwise supported Web Crypto browsers.
  // Generate an RFC 4122 v4 key from cryptographically secure random bytes.
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-")
}
