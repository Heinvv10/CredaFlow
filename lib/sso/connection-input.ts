import { X509Certificate } from "node:crypto"
import { isMappableRole, parseGroupRoleMap, type GroupRoleMap, type MappableRole } from "./groups"

/**
 * Validation of what a SUPER_ADMIN submits for the lender's SSO connection.
 * Every rule here is also a CHECK constraint on SsoConnection where the
 * database can say it (migration 20261029100000_sso_oauth): this gives the
 * admin a readable refusal instead of a constraint error.
 */

export type SsoProtocolName = "OIDC" | "SAML"

export interface ConnectionFields {
  protocol: SsoProtocolName
  enabled: boolean
  oidcIssuer: string | null
  oidcClientId: string | null
  oidcScopes: string[]
  samlEntityId: string | null
  samlIdpEntityId: string | null
  samlSubjectAttribute: string | null
  samlIdpSsoUrl: string | null
  samlIdpCert: string | null
  emailClaim: string
  groupsClaim: string
  allowedEmailDomains: string[]
  allowUnverifiedEmail: boolean
  groupRoleMap: GroupRoleMap
  jitProvisioning: boolean
  jitDefaultRole: MappableRole | null
  mfaAcrValues: string[]
  passwordLoginDisabled: boolean
  sessionHours: number
}

export type ConnectionInputResult =
  | { ok: true; value: ConnectionFields; clientSecret: string | null }
  | { ok: false; error: string }

type Existing = { protocol: SsoProtocolName; oidcClientSecretSealed: string | null } | null
type Obj = Record<string, unknown>

const DEFAULT_SCOPES = ["openid", "email", "profile"]
const SCOPE_TOKEN = /^[\x21\x23-\x5B\x5D-\x7E]{1,100}$/
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
const CLAIM_NAME = /^[\x21-\x7E]{1,200}$/
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (v: unknown, max = 2048): string | null => (typeof v === "string" && v.trim() !== "" && v.length <= max ? v.trim() : null)
const strList = (v: unknown, max = 50): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.trim() !== "") ? [...new Set(v.map((x: string) => x.trim()))] : null

function httpsUrl(value: unknown, allowPath: boolean): string | null {
  const raw = str(value)
  if (!raw || !URL.canParse(raw)) return null
  const url = new URL(raw)
  if (url.protocol !== "https:" || url.username || url.password || url.hash) return null
  if (!allowPath && url.search) return null
  return raw
}

/** The certificates in a PEM bundle, normalised; null if none parse or any does not. */
function certificates(value: unknown): string | null {
  const raw = str(value, 20_000)
  const blocks = raw?.match(PEM_BLOCK)
  if (!blocks || blocks.length > 3) return null
  try {
    return blocks.map((b) => { new X509Certificate(b); return b.trim() }).join("\n")
  } catch {
    return null
  }
}

export function parseConnectionInput(body: unknown, existing: Existing): ConnectionInputResult {
  const fail = (error: string): ConnectionInputResult => ({ ok: false, error })
  if (!isObj(body)) return fail("Send a JSON object.")
  const protocol = body.protocol
  if (protocol !== "OIDC" && protocol !== "SAML") return fail("Choose OIDC or SAML.")
  if (typeof body.enabled !== "boolean") return fail("Say whether single sign-on is enabled.")

  let oidcIssuer: string | null = null, oidcClientId: string | null = null, clientSecret: string | null = null
  let oidcScopes: string[] = []
  let samlEntityId: string | null = null, samlSubjectAttribute: string | null = null, samlIdpEntityId: string | null = null, samlIdpSsoUrl: string | null = null, samlIdpCert: string | null = null
  if (protocol === "OIDC") {
    const o = isObj(body.oidc) ? body.oidc : {}
    oidcIssuer = httpsUrl(o.issuer, true)
    if (!oidcIssuer) return fail("The issuer must be an https URL without credentials, query or fragment.")
    if (new URL(oidcIssuer).search) return fail("The issuer must be an https URL without credentials, query or fragment.")
    oidcClientId = str(o.clientId, 256)
    if (!oidcClientId) return fail("Enter the client id.")
    if (o.clientSecret !== undefined && o.clientSecret !== "") {
      clientSecret = str(o.clientSecret, 1024)
      if (!clientSecret) return fail("The client secret is not valid.")
    } else if (existing?.protocol !== "OIDC" || !existing.oidcClientSecretSealed) {
      return fail("Enter the client secret.")
    }
    const scopes = o.scopes === undefined ? DEFAULT_SCOPES : strList(o.scopes, 20)
    if (!scopes || !scopes.every((s) => SCOPE_TOKEN.test(s)) || !scopes.includes("openid")) return fail("Scopes must be valid and include openid.")
    oidcScopes = scopes
  } else {
    const s = isObj(body.saml) ? body.saml : {}
    samlEntityId = str(s.entityId, 512)
    if (!samlEntityId) return fail("Enter the service provider entity id.")
    samlIdpEntityId = str(s.idpEntityId, 512)
    if (!samlIdpEntityId) return fail("Enter the identity provider's entity id (issuer).")
    if (s.subjectAttribute !== undefined && s.subjectAttribute !== null && s.subjectAttribute !== "") {
      samlSubjectAttribute = str(s.subjectAttribute, 200)
      if (!samlSubjectAttribute || !CLAIM_NAME.test(samlSubjectAttribute)) return fail("The subject attribute name is not valid.")
    }
    samlIdpSsoUrl = httpsUrl(s.idpSsoUrl, true)
    if (!samlIdpSsoUrl) return fail("The identity provider sign-in URL must be an https URL.")
    samlIdpCert = certificates(s.idpCert)
    if (!samlIdpCert) return fail("Paste the identity provider's signing certificate (PEM, up to three for key rollover).")
  }

  const emailClaim = body.emailClaim === undefined ? "email" : str(body.emailClaim, 200)
  const groupsClaim = body.groupsClaim === undefined ? "groups" : str(body.groupsClaim, 200)
  if (!emailClaim || !CLAIM_NAME.test(emailClaim) || !groupsClaim || !CLAIM_NAME.test(groupsClaim)) return fail("Claim names are not valid.")

  const domains = body.allowedEmailDomains === undefined ? [] : strList(body.allowedEmailDomains, 50)
  const allowedEmailDomains = domains?.map((d) => d.toLowerCase())
  if (!allowedEmailDomains || !allowedEmailDomains.every((d) => DOMAIN.test(d))) return fail("Allowed email domains are not valid.")

  if (body.enabled && allowedEmailDomains.length === 0) return fail("Name the email domains that may sign in before single sign-on is switched on.")
  if (body.allowUnverifiedEmail !== undefined && typeof body.allowUnverifiedEmail !== "boolean") return fail("allowUnverifiedEmail must be true or false.")

  const groupRoleMap = parseGroupRoleMap(body.groupRoleMap ?? {})
  if (!groupRoleMap) return fail("Group mappings may only assign lender roles below Super Admin.")

  const jitProvisioning = body.jitProvisioning === true
  const jitDefaultRole = body.jitDefaultRole === undefined || body.jitDefaultRole === null ? null : body.jitDefaultRole
  if (jitDefaultRole !== null && !isMappableRole(jitDefaultRole)) return fail("The default role for new users may not be Super Admin or an operator role.")
  if (jitProvisioning && jitDefaultRole === null) return fail("Choose the default role for users created on first sign-in.")

  const mfaAcrValues = body.mfaAcrValues === undefined ? [] : strList(body.mfaAcrValues, 20)
  if (!mfaAcrValues) return fail("MFA context values are not valid.")

  const sessionHours = body.sessionHours === undefined ? 10 : body.sessionHours
  if (typeof sessionHours !== "number" || !Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 168) return fail("The session lifetime must be a whole number of hours from 1 to 168.")

  const passwordLoginDisabled = body.passwordLoginDisabled === true
  if (passwordLoginDisabled && !body.enabled) return fail("Password sign-in can be turned off only while single sign-on is enabled.")

  return {
    ok: true,
    clientSecret,
    value: {
      protocol, enabled: body.enabled, oidcIssuer, oidcClientId, oidcScopes, samlEntityId, samlIdpEntityId, samlSubjectAttribute, samlIdpSsoUrl, samlIdpCert,
      emailClaim, groupsClaim, allowedEmailDomains, allowUnverifiedEmail: body.allowUnverifiedEmail === true, groupRoleMap, jitProvisioning, jitDefaultRole,
      mfaAcrValues, passwordLoginDisabled, sessionHours,
    },
  }
}
