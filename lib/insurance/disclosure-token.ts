/**
 * HMAC-signed draft tokens for FAIS disclosure flow.
 *
 * Token format: `<base64url(json-payload)>.<base64url(hmac-sha256)>`
 * The payload binds the tenant + client + advisor + policy draft fields so
 * the disclosure PDF cannot be reused for a different policy. iat enforces
 * a 1-hour TTL. Verification is timing-safe.
 *
 * Consumers: app/api/insurance/policies/draft/route.ts (sign),
 *            app/api/insurance/disclosures/[token]/route.ts (verify + serve PDF),
 *            app/api/insurance/policies/route.ts (verify on gate enforcement).
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto"

const TOKEN_TTL_MS = 60 * 60 * 1000 // 1 hour

export interface DraftPayload {
  tenantId: string
  clientId: string
  advisorId: string
  type: string
  sumAssured: number
  premiumAmount: number
  productId: string | null
  /**
   * The quote this disclosure was issued FOR, when it came from the quote path.
   *
   * Absent on tokens minted by the legacy single-life draft route, and that
   * asymmetry is deliberate: `bindQuote` REQUIRES it, so a legacy token can
   * never bind a quote, and a token issued for quote X can never bind quote Y
   * even when the two share a client, a product and identical totals. Without
   * it the token is fungible between quotes and the bind's comparison is
   * satisfied by figures rather than by identity.
   */
  quoteId?: string | null
  iat?: number
}

/** Payload shape after sign + verify: iat is guaranteed present, productId is intentionally nullable. */
export interface SignedDraftPayload {
  tenantId: string
  clientId: string
  advisorId: string
  type: string
  sumAssured: number
  premiumAmount: number
  productId: string | null
  /** See `DraftPayload.quoteId`. Undefined on legacy single-life tokens. */
  quoteId?: string | null
  iat: number
}

type VerifyResult =
  | { ok: true; payload: SignedDraftPayload }
  | { ok: false; reason: "invalid_format" | "invalid_signature" | "expired" | "missing_secret" }

function b64url(buf: Buffer): string {
  return buf.toString("base64url")
}

function getSecret(): string | null {
  const s = process.env.NEXTAUTH_SECRET
  return s && s.length >= 16 ? s : null
}

export function signDraftToken(payload: DraftPayload): string {
  const secret = getSecret()
  if (!secret) throw new Error("NEXTAUTH_SECRET not configured (min 16 chars)")
  const withIat: SignedDraftPayload = { ...payload, iat: payload.iat ?? Date.now() }
  const payloadBytes = Buffer.from(JSON.stringify(withIat), "utf8")
  const sig = createHmac("sha256", secret).update(payloadBytes).digest()
  return `${b64url(payloadBytes)}.${b64url(sig)}`
}

export function verifyDraftToken(token: string): VerifyResult {
  const secret = getSecret()
  if (!secret) return { ok: false, reason: "missing_secret" }
  const parts = token.split(".")
  if (parts.length !== 2) return { ok: false, reason: "invalid_format" }
  const [payloadB64, sigB64] = parts
  const payloadBytes = Buffer.from(payloadB64, "base64url")
  const givenSig = Buffer.from(sigB64, "base64url")
  const expected = createHmac("sha256", secret).update(payloadBytes).digest()
  try {
    if (!timingSafeEqual(expected, givenSig)) {
      return { ok: false, reason: "invalid_signature" }
    }
  } catch {
    return { ok: false, reason: "invalid_signature" }
  }
  let payload: SignedDraftPayload
  try { payload = JSON.parse(payloadBytes.toString("utf8")) }
  catch { return { ok: false, reason: "invalid_format" } }
  if (typeof payload.iat !== "number") return { ok: false, reason: "invalid_format" }
  if (Date.now() - payload.iat > TOKEN_TTL_MS) return { ok: false, reason: "expired" }
  return { ok: true, payload }
}

/**
 * R-09: sha256 of a draft token, hex.
 *
 * Persisted as `InsurancePolicy.faisDraftTokenHash` under a unique index, so a
 * token (which is valid for an hour) cannot be replayed to mint a second
 * policy. It lives HERE, beside the signing and verification it belongs to,
 * because two callers now consume a token — app/api/insurance/policies/route.ts
 * and lib/insurance/policy/bind.ts — and two private copies of this function
 * that drifted by even a trailing newline would compute different hashes,
 * silently disabling replay protection ACROSS the two paths while each looked
 * correct on its own.
 */
export function hashDraftToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}
