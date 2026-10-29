import { hkdfSync } from "node:crypto"

/**
 * A 32-byte signing key for one purpose, derived (HKDF-SHA256) from the
 * deployment's session secret. The context string keeps purposes apart: a token
 * signed for one (an SSO ticket, an OAuth access token) never verifies as
 * another. Rotating AUTH_SECRET rotates every derived key.
 */
export function derivedKey(context: string): Buffer {
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET
  if (!secret || secret.length < 32) throw new Error("AUTH_SECRET (at least 32 characters) is required to derive signing keys")
  return Buffer.from(hkdfSync("sha256", secret, "credaflow", context, 32))
}
