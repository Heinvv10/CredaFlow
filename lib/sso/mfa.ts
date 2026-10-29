/**
 * Whether the identity provider proved a second factor for this sign-in. The
 * lender chooses whether that stands in for CredaFlow's own TOTP
 * (SsoConnection.trustIdpMfa); this module only reads the claim.
 *
 * OIDC: `amr` (RFC 8176) proves it when it holds "mfa", or methods from two
 * different factor types (knowledge, possession, inherence). `acr` proves it
 * only when the lender named that value (SsoConnection.mfaAcrValues): acr
 * values are provider-specific. SAML: the AuthnContextClassRef, against a
 * short list of standard MFA classes plus the lender's own.
 */

const KNOWLEDGE = new Set(["pwd", "pin", "kba"])
const POSSESSION = new Set(["otp", "hwk", "swk", "sc", "sms", "tel"])
const INHERENCE = new Set(["fpt", "face", "iris", "retina", "vbm"])

const SAML_MFA_CLASSES = [
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorContract",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:MobileTwoFactorUnregistered",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:TimeSyncToken",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:Smartcard",
  "urn:oasis:names:tc:SAML:2.0:ac:classes:SmartcardPKI",
]

export function oidcMfaProven(claims: { amr?: unknown; acr?: unknown }, lenderAcrValues: readonly string[]): boolean {
  if (typeof claims.acr === "string" && lenderAcrValues.includes(claims.acr)) return true
  const amr = claims.amr
  if (!Array.isArray(amr) || !amr.every((m) => typeof m === "string")) return false
  if (amr.includes("mfa")) return true
  const types = [KNOWLEDGE, POSSESSION, INHERENCE].filter((set) => amr.some((m: string) => set.has(m)))
  return types.length >= 2
}

export function samlMfaProven(authnContextClassRef: string | undefined, lenderAcrValues: readonly string[]): boolean {
  if (!authnContextClassRef) return false
  return SAML_MFA_CLASSES.includes(authnContextClassRef) || lenderAcrValues.includes(authnContextClassRef)
}
