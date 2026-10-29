import { SAML, ValidateInResponseTo, type Profile } from "@node-saml/node-saml"
import { randomBytes } from "node:crypto"
import type { LoadedConnection } from "./connection"
import { DbSamlCache } from "./cache"
import { samlMfaProven } from "./mfa"
import type { IdpIdentity } from "./identity"
import { mintState, type SsoFlowState } from "./tokens"

/**
 * SAML 2.0 web browser SSO (SP-initiated, HTTP-Redirect request, HTTP-POST
 * response) with @node-saml/node-saml. What the library enforces here:
 *
 *  - the Assertion is signed by the identity provider's certificate (the
 *    lender may give up to three, for rollover); an unsigned or wrongly signed
 *    assertion is refused,
 *  - the issuer, audience, NotBefore / NotOnOrAfter (one minute of skew) and a
 *    maximum assertion age,
 *  - InResponseTo must answer a request THIS server issued and not yet
 *    answered (request ids live in SsoCacheEntry, shared by every replica), so
 *    an unsolicited, IdP-initiated or replayed response is refused,
 *  - an assertion id is accepted once (rejectReplayedAssertions).
 * Added here: the bearer Recipient must be our ACS URL, and the RelayState must
 * match the browser's signed state cookie (login CSRF).
 */

const REQUEST_LIFE_MS = 10 * 60_000
const SKEW_MS = 60_000
const MAX_ASSERTION_AGE_MS = 5 * 60_000

export class SamlFlowError extends Error {
  constructor(readonly code: "invalid_response" | "state_mismatch" | "no_email" | "bad_recipient" | "missing_state", cause?: unknown) {
    super(code, { cause })
    this.name = "SamlFlowError"
  }
}

function samlFor(conn: LoadedConnection, acsUrl: string): SAML {
  if (!conn.samlEntityId || !conn.samlIdpSsoUrl || !conn.samlIdpCert || !conn.samlIdpEntityId) throw new SamlFlowError("invalid_response")
  const certs = conn.samlIdpCert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  return new SAML({
    callbackUrl: acsUrl,
    entryPoint: conn.samlIdpSsoUrl,
    issuer: conn.samlEntityId,
    audience: conn.samlEntityId,
    idpIssuer: conn.samlIdpEntityId,
    idpCert: certs,
    signatureAlgorithm: "sha256",
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    acceptedClockSkewMs: SKEW_MS,
    maxAssertionAgeMs: MAX_ASSERTION_AGE_MS,
    validateInResponseTo: ValidateInResponseTo.always,
    rejectReplayedAssertions: true,
    requestIdExpirationPeriodMs: REQUEST_LIFE_MS,
    cacheProvider: new DbSamlCache(conn.tenantId, REQUEST_LIFE_MS),
    // The provider chooses how to authenticate; MFA is judged from what it reports.
    disableRequestedAuthnContext: true,
  })
}

/** The redirect to the identity provider and the signed state to set as a cookie. */
export async function beginSaml(
  conn: LoadedConnection, args: { acsUrl: string; returnTo: string },
): Promise<{ url: string; stateToken: string }> {
  const relay = randomBytes(24).toString("base64url")
  const url = await samlFor(conn, args.acsUrl).getAuthorizeUrlAsync(relay, undefined, {})
  const flow: SsoFlowState = { tenantId: conn.tenantId, state: relay, returnTo: args.returnTo }
  return { url, stateToken: await mintState(flow) }
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []

function classRefOf(assertionXml: string): string | undefined {
  return /<(?:[\w-]+:)?AuthnContextClassRef[^>]*>\s*([^<\s][^<]*?)\s*</.exec(assertionXml)?.[1]
}

function recipientsOf(assertionXml: string): string[] {
  return [...assertionXml.matchAll(/<(?:[\w-]+:)?SubjectConfirmationData\b[^>]*?\bRecipient="([^"]*)"/g)].map((m) => m[1])
}

/** Validate the POSTed response and read who signed in. Throws SamlFlowError on any failure. */
export async function completeSaml(
  conn: LoadedConnection,
  args: { acsUrl: string; samlResponse: string; relayState: string | null; flow: SsoFlowState },
): Promise<IdpIdentity> {
  const { flow } = args
  if (flow.tenantId !== conn.tenantId) throw new SamlFlowError("missing_state")
  if (!args.relayState || args.relayState !== flow.state) throw new SamlFlowError("state_mismatch")
  let profile: Profile | null
  try {
    ;({ profile } = await samlFor(conn, args.acsUrl).validatePostResponseAsync({ SAMLResponse: args.samlResponse }))
  } catch (error) {
    throw new SamlFlowError("invalid_response", error)
  }
  const assertionXml = profile?.getAssertionXml?.()
  if (!profile || !assertionXml) throw new SamlFlowError("invalid_response")
  if (!recipientsOf(assertionXml).includes(args.acsUrl)) throw new SamlFlowError("bad_recipient")

  const attributeEmail = profile[conn.emailClaim]
  const email = (typeof attributeEmail === "string" && attributeEmail) || (profile.nameID.includes("@") ? profile.nameID : "")
  if (!email) throw new SamlFlowError("no_email")
  const display = profile.displayName ?? profile.name
  return {
    subject: `${conn.samlIdpEntityId}|${profile.nameID}`,
    email,
    // The assertion is signed by the lender's own identity provider, and subjects are bound to the account: SAML has no
    // email_verified, the provider vouches for the attribute it signs.
    emailVerified: true,
    name: typeof display === "string" ? display : null,
    groups: asList(profile[conn.groupsClaim]),
    mfaProven: samlMfaProven(classRefOf(assertionXml), conn.mfaAcrValues),
  }
}
