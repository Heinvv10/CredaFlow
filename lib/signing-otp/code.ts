/**
 * Signing OTP primitives: lifetime constants, the keyed code hash and the
 * masked destination recorded as evidence.
 *
 * A 6-digit code has 10^6 values, so a plain SHA-256 of it is reversed in
 * milliseconds by anyone who can read the row. The stored hash is an HMAC
 * keyed with AUTH_SECRET and bound to the challenge id: a database reader
 * without the app secret learns nothing, and a hash cannot be replayed onto
 * another challenge.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

export const SIGNING_OTP_TTL_MS = 5 * 60 * 1000
export const SIGNING_OTP_MAX_ATTEMPTS = 5
/** A verified code must be used to sign within this long. */
export const SIGNING_OTP_SIGN_WINDOW_MS = 15 * 60 * 1000
/** Codes one client may request for one signing subject per window. */
export const SIGNING_OTP_REQUEST_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 } as const

function otpKey(): string {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET is required to hash a signing OTP")
  return secret
}

export function hashSigningOtp(challengeId: string, code: string): string {
  return createHmac("sha256", otpKey()).update(`signing-otp:v1:${challengeId}:${code}`).digest("hex")
}

/** Constant-time comparison of a submitted code against the stored hash. */
export function signingOtpMatches(challengeId: string, submitted: string, codeHash: string): boolean {
  const code = submitted.replace(/\s+/g, "")
  if (!/^\d{6}$/.test(code)) return false
  const expected = Buffer.from(codeHash, "hex")
  const actual = Buffer.from(hashSigningOtp(challengeId, code), "hex")
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/**
 * A random reference printed in the message. It is never stored: the
 * messaging pipeline keeps a fingerprint of the true (unredacted) body, and
 * this term makes that fingerprint unsearchable for the 6-digit code.
 */
export function otpRequestReference(): string {
  return randomBytes(6).toString("hex").toUpperCase()
}

/** "thandi.mokoena@example.com" → "t***a@e***.com" */
export function maskEmail(email: string): string {
  const [local, domain] = email.trim().toLowerCase().split("@")
  if (!local || !domain) return "***"
  const dot = domain.lastIndexOf(".")
  const host = dot > 0 ? domain.slice(0, dot) : domain
  const tld = dot > 0 ? domain.slice(dot) : ""
  const localMasked = local.length <= 2 ? `${local[0]}***` : `${local[0]}***${local[local.length - 1]}`
  return `${localMasked}@${host[0]}***${tld}`
}

/** "27821234567" or "27821234567@s.whatsapp.net" → "+27 *** *** 4567" */
export function maskPhone(value: string): string {
  const digits = value.split("@")[0].replace(/\D/g, "")
  if (digits.length < 6) return "***"
  return `+${digits.slice(0, 2)} *** *** ${digits.slice(-4)}`
}
