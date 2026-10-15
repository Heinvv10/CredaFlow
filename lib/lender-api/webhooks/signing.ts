import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"

/**
 * Outbound webhook signatures.
 *
 *   CredaFlow-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * The receiver recomputes the HMAC over the raw body with its endpoint secret,
 * compares in constant time, and rejects a timestamp older than its tolerance
 * (replay). verifyWebhookSignature is the reference implementation, used by
 * the tests and quoted in the OpenAPI description.
 */
export const SIGNATURE_HEADER = "CredaFlow-Signature"
export const DEFAULT_TOLERANCE_SECONDS = 300

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("base64url")}`
}

function hmac(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")
}

export function signWebhookBody(secret: string, body: string, timestamp: number = Math.floor(Date.now() / 1000)): string {
  return `t=${timestamp},v1=${hmac(secret, timestamp, body)}`
}

export function verifyWebhookSignature(
  secret: string,
  header: string | null,
  body: string,
  opts: { now?: number; toleranceSeconds?: number } = {},
): boolean {
  if (!header) return false
  const parts = new Map(header.split(",").map((p) => {
    const i = p.indexOf("=")
    return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const
  }))
  const t = Number(parts.get("t"))
  const v1 = parts.get("v1") ?? ""
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return false
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  if (Math.abs(now - t) > (opts.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) return false
  const expected = Buffer.from(hmac(secret, t, body), "hex")
  return timingSafeEqual(expected, Buffer.from(v1, "hex"))
}
