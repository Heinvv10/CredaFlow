import { createHmac, timingSafeEqual } from "node:crypto"

export type WebhookProvider = "TWILIO" | "BULKSMS" | "META_WA" | "WA_UNOFFICIAL"

export type VerifyFailureReason =
  | "MISSING_HEADER"
  | "BAD_HMAC"
  | "STALE_TIMESTAMP" // reserved for future per-provider replay protection
  | "REPLAY"          // reserved for future per-provider replay protection

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailureReason }

// `Buffer.from(str, "base64")` silently strips embedded whitespace before
// decoding, so two distinct strings that differ only in interior spaces
// produce byte-identical buffers and would slip past `timingSafeEqual`.
// The strict character-class check rejects whitespace + any non-base64
// byte before decoding, keeping the comparison exact.
const BASE64_STRICT = /^[A-Za-z0-9+/]+={0,2}$/

function safeCompareBase64(expected: string, presented: string): boolean {
  if (!BASE64_STRICT.test(presented)) return false
  const a = Buffer.from(expected, "base64")
  const b = Buffer.from(presented, "base64")
  if (a.byteLength === 0 || a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

// Hex is strict: `Buffer.from(str, "hex")` truncates at the first non-hex
// character without throwing, but the explicit `HEX_STRICT` check rejects
// whitespace, "0x" prefixes, or any other malformed input up front instead
// of relying on the post-decode byte-length comparison to catch it.
const HEX_STRICT = /^[a-fA-F0-9]+$/

function safeCompareHex(expected: string, presented: string): boolean {
  if (expected.length !== presented.length) return false
  if (!HEX_STRICT.test(presented)) return false
  const a = Buffer.from(expected, "hex")
  const b = Buffer.from(presented, "hex")
  if (a.byteLength === 0 || a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/**
 * Twilio webhook signature verification.
 *
 * Algorithm (per twilio docs): HMAC-SHA1 over `fullUrl + concat(sortedKeys.map(k => k + value))`,
 * base64-encoded. Compared against the `x-twilio-signature` header.
 */
export function verifyTwilio(opts: {
  fullUrl: string
  formParams: Record<string, string>
  headers: Headers
  secret: string
}): VerifyResult {
  const presented = opts.headers.get("x-twilio-signature")
  if (!presented) return { ok: false, reason: "MISSING_HEADER" }

  const sortedParams = Object.keys(opts.formParams).sort()
    .map(k => `${k}${opts.formParams[k]}`)
    .join("")
  const expected = createHmac("sha1", opts.secret)
    .update(opts.fullUrl + sortedParams)
    .digest("base64")

  return safeCompareBase64(expected, presented)
    ? { ok: true }
    : { ok: false, reason: "BAD_HMAC" }
}

/**
 * Body-HMAC verifier — shared core for BulkSMS + unofficial-WA.
 *
 * Both providers sign the raw request body with HMAC-SHA256 using a shared
 * secret and present the lowercase hex digest in a single header. The only
 * per-provider difference is the header name.
 */
function verifyBodyHmacSha256Hex(opts: {
  rawBody: string
  headers: Headers
  headerName: string
  secret: string
}): VerifyResult {
  const presented = opts.headers.get(opts.headerName)
  if (!presented) return { ok: false, reason: "MISSING_HEADER" }
  const expected = createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex")
  return safeCompareHex(expected, presented)
    ? { ok: true }
    : { ok: false, reason: "BAD_HMAC" }
}

export function verifyBulkSms(opts: {
  rawBody: string
  headers: Headers
  secret: string
}): VerifyResult {
  return verifyBodyHmacSha256Hex({
    rawBody: opts.rawBody,
    headers: opts.headers,
    headerName: "x-bulksms-hmac",
    secret: opts.secret,
  })
}

export function verifyWaUnofficial(opts: {
  rawBody: string
  headers: Headers
  secret: string
}): VerifyResult {
  return verifyBodyHmacSha256Hex({
    rawBody: opts.rawBody,
    headers: opts.headers,
    headerName: "x-wa-signature",
    secret: opts.secret,
  })
}

/**
 * Meta / WhatsApp Business API webhook signature verification.
 *
 * Algorithm: HMAC-SHA256 of the raw body using the app secret, hex-encoded,
 * presented as `sha256=<hex>` in the `x-hub-signature-256` header. The
 * prefix is mandatory per Meta's documented format; a hex string without
 * the prefix is a malformed signature → BAD_HMAC.
 */
export function verifyWaba(opts: {
  rawBody: string
  headers: Headers
  secret: string
}): VerifyResult {
  const presented = opts.headers.get("x-hub-signature-256")
  if (!presented) return { ok: false, reason: "MISSING_HEADER" }
  if (!presented.startsWith("sha256=")) return { ok: false, reason: "BAD_HMAC" }
  const presentedHex = presented.slice("sha256=".length)
  const expected = createHmac("sha256", opts.secret).update(opts.rawBody).digest("hex")
  return safeCompareHex(expected, presentedHex)
    ? { ok: true }
    : { ok: false, reason: "BAD_HMAC" }
}
