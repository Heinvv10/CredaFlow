import { createHmac, timingSafeEqual } from "node:crypto"

export type UnsubPayload = {
  contactId: string
  channel: "EMAIL" // reserved for future channels
  purpose: "MARKETING_GENERAL" // reserved for future purposes
  exp: number // unix ms epoch
}

export type VerifyUnsubResult =
  | { ok: true; payload: UnsubPayload }
  | { ok: false; reason: "MALFORMED" | "BAD_SIG" | "EXPIRED" }

/**
 * Sign an unsubscribe token. Format: `<base64url(JSON.stringify(payload))>.<base64url(hmac)>`.
 *
 * The signing-side stringification is deterministic because Node's
 * JSON.stringify visits keys in insertion order. The verifier re-signs the
 * `payload` slice verbatim from the token — it never re-stringifies, so
 * key-order drift between sign + verify is impossible.
 */
export function signUnsubToken(payload: UnsubPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const sig = createHmac("sha256", secret).update(body).digest()
  return `${body}.${Buffer.from(sig).toString("base64url")}`
}

/**
 * Verify an unsubscribe token. Returns the parsed payload on success or a
 * tagged-union failure reason. NEVER throws.
 */
export function verifyUnsubToken(token: string, secret: string): VerifyUnsubResult {
  const dotAt = token.indexOf(".")
  if (dotAt <= 0 || dotAt === token.length - 1) {
    return { ok: false, reason: "MALFORMED" }
  }
  const body = token.slice(0, dotAt)
  const sigB64 = token.slice(dotAt + 1)

  // `Buffer.from(str, "base64url")` does not throw on malformed input —
  // it silently drops non-base64url bytes and returns a (possibly empty)
  // buffer. The zero-length guard below is the actual reject path.
  const sigBuf = Buffer.from(sigB64, "base64url")
  if (sigBuf.byteLength === 0) {
    return { ok: false, reason: "MALFORMED" }
  }

  const expected = createHmac("sha256", secret).update(body).digest()
  if (expected.byteLength !== sigBuf.byteLength || !timingSafeEqual(expected, sigBuf)) {
    return { ok: false, reason: "BAD_SIG" }
  }

  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"))
  } catch {
    return { ok: false, reason: "MALFORMED" }
  }
  if (!isUnsubPayload(payload)) {
    return { ok: false, reason: "MALFORMED" }
  }

  if (payload.exp <= Date.now()) {
    return { ok: false, reason: "EXPIRED" }
  }

  return { ok: true, payload }
}

function isUnsubPayload(value: unknown): value is UnsubPayload {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.contactId === "string"
    && v.contactId.length > 0
    && v.channel === "EMAIL"
    && v.purpose === "MARKETING_GENERAL"
    && typeof v.exp === "number"
    && Number.isFinite(v.exp)
}
