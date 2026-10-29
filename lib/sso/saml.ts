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

const PERSISTENT = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"
const REQUEST_LIFE_MS = 10 * 60_000
const SKEW_MS = 60_000
const MAX_ASSERTION_AGE_MS = 5 * 60_000

export class SamlFlowError extends Error {
  constructor(readonly code: "invalid_response" | "state_mismatch" | "no_email" | "no_subject" | "bad_recipient" | "request_mismatch" | "missing_state", cause?: unknown) {
    super(code, { cause })
    this.name = "SamlFlowError"
  }
}

function samlFor(conn: LoadedConnection, acsUrl: string, requestId?: string): SAML {
  if (!conn.samlEntityId || !conn.samlIdpSsoUrl || !conn.samlIdpCert || !conn.samlIdpEntityId) throw new SamlFlowError("invalid_response")
  const certs = conn.samlIdpCert.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? []
  return new SAML({
    callbackUrl: acsUrl,
    entryPoint: conn.samlIdpSsoUrl,
    issuer: conn.samlEntityId,
    audience: conn.samlEntityId,
    idpIssuer: conn.samlIdpEntityId,
    idpCert: certs,
    // Ask for the one NameID format subjectOf() accepts (the library's default, emailAddress, would make every sign-in fail).
    identifierFormat: conn.samlSubjectAttribute ? null : PERSISTENT,
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
    // We choose the AuthnRequest id so it can ride in the browser's signed flow state.
    ...(requestId ? { generateUniqueId: () => requestId } : {}),
  })
}

/** The redirect to the identity provider and the signed state to set as a cookie. */
export async function beginSaml(
  conn: LoadedConnection, args: { acsUrl: string; returnTo: string },
): Promise<{ url: string; stateToken: string }> {
  const relay = randomBytes(24).toString("base64url")
  const requestId = `_${randomBytes(20).toString("hex")}`
  const url = await samlFor(conn, args.acsUrl, requestId).getAuthorizeUrlAsync(relay, undefined, {})
  const flow: SsoFlowState = { tenantId: conn.tenantId, state: relay, requestId, returnTo: args.returnTo }
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

function inResponseTosOf(assertionXml: string): string[] {
  return [...assertionXml.matchAll(/<(?:[\w-]+:)?SubjectConfirmationData\b[^>]*?\bInResponseTo="([^"]*)"/g)].map((m) => m[1])
}

/**
 * The stable id of the person: the lender's immutable attribute (objectGUID, immutableId) when one is configured,
 * else a PERSISTENT NameID. Transient, email-address and unspecified NameIDs are refused as subjects: an email can be
 * re-assigned to someone else at the provider, which is the takeover the binding exists to stop.
 */
function subjectOf(conn: LoadedConnection, profile: Profile): string {
  const idp = conn.samlIdpEntityId
  if (conn.samlSubjectAttribute) {
    const value = profile[conn.samlSubjectAttribute]
    if (typeof value !== "string" || value.trim() === "") throw new SamlFlowError("no_subject")
    return `${idp}|${value.trim()}`
  }
  if (profile.nameIDFormat !== PERSISTENT || typeof profile.nameID !== "string" || profile.nameID.trim() === "") throw new SamlFlowError("no_subject")
  return `${idp}|${profile.nameID.trim()}`
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
  // The library only checks that the response answers SOME request this server issued. It must answer the one THIS browser sent.
  const answered = inResponseTosOf(assertionXml)
  if (!flow.requestId || answered.length === 0 || !answered.every((id) => id === flow.requestId)) throw new SamlFlowError("request_mismatch")
  const subject = subjectOf(conn, profile)

  const attributeEmail = profile[conn.emailClaim]
  // A multi-valued (or non-text) email attribute is ambiguous: refused, never replaced by the NameID.
  if (attributeEmail !== undefined && typeof attributeEmail !== "string") throw new SamlFlowError("no_email")
  const email = attributeEmail || (profile.nameID.includes("@") ? profile.nameID : "")
  if (!email) throw new SamlFlowError("no_email")
  const display = profile.displayName ?? profile.name
  return {
    subject,
    email,
    // The assertion is signed by the lender's own identity provider, and subjects are bound to the account: SAML has no
    // email_verified, the provider vouches for the attribute it signs.
    emailVerified: true,
    name: typeof display === "string" ? display : null,
    groups: asList(profile[conn.groupsClaim]),
    mfaProven: samlMfaProven(classRefOf(assertionXml), conn.mfaAcrValues),
  }
}

/** The service provider metadata the lender's identity team imports (entity id, ACS URL, bearer binding). */
export function samlServiceProviderMetadata(conn: LoadedConnection, acsUrl: string): string {
  return samlFor(conn, acsUrl).generateServiceProviderMetadata(null, null)
}
