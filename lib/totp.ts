/**
 * TOTP implementation using Node.js built-in crypto.
 * RFC 6238 — Time-Based One-Time Password.
 */

import { createHmac, randomBytes } from "crypto"

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

export function generateTotpSecret(): string {
  const bytes = randomBytes(20)
  let result = ""
  let buffer = 0
  let bitsLeft = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bitsLeft += 8
    while (bitsLeft >= 5) {
      bitsLeft -= 5
      result += BASE32_CHARS[(buffer >> bitsLeft) & 0x1f]
    }
  }
  if (bitsLeft > 0) {
    result += BASE32_CHARS[(buffer << (5 - bitsLeft)) & 0x1f]
  }
  return result
}

function base32Decode(input: string): Buffer {
  const s = input.toUpperCase().replace(/=+$/, "")
  let buffer = 0
  let bitsLeft = 0
  const output: number[] = []
  for (const char of s) {
    const val = BASE32_CHARS.indexOf(char)
    if (val < 0) continue
    buffer = (buffer << 5) | val
    bitsLeft += 5
    if (bitsLeft >= 8) {
      bitsLeft -= 8
      output.push((buffer >> bitsLeft) & 0xff)
    }
  }
  return Buffer.from(output)
}

function generateHotp(secret: string, counter: number): string {
  const key = base32Decode(secret)
  const buf = Buffer.alloc(8)
  let c = counter
  for (let i = 7; i >= 0; i--) {
    buf[i] = c & 0xff
    c = Math.floor(c / 256)
  }
  const hmac = createHmac("sha1", key).update(buf).digest()
  const offset = hmac[19] & 0x0f
  const code = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  return String(code % 1_000_000).padStart(6, "0")
}

export function generateTotpCode(secret: string, time = Date.now()): string {
  const counter = Math.floor(time / 1000 / 30)
  return generateHotp(secret, counter)
}

/**
 * Returns the matched counter (a Unix 30s epoch integer) if valid, null otherwise.
 * Callers should persist the matched counter and reject any future login that
 * presents the same or earlier counter (replay protection).
 */
export function verifyTotpCode(token: string, secret: string, time = Date.now(), window = 1): number | null {
  const counter = Math.floor(time / 1000 / 30)
  for (let i = -window; i <= window; i++) {
    if (generateHotp(secret, counter + i) === token) return counter + i
  }
  return null
}

export function generateTotpUri(email: string, secret: string, issuer: string): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(email)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}`
}
