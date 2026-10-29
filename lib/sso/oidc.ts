import * as client from "openid-client"
import { createRemoteJWKSet, customFetch as joseCustomFetch, jwtVerify } from "jose"
import { resolvePublic, systemResolver } from "@/lib/lender-api/webhooks/ssrf"
import type { LoadedConnection } from "./connection"
import { openClientSecret } from "./connection"
import { oidcMfaProven } from "./mfa"
import type { IdpIdentity } from "./identity"
import { mintState, type SsoFlowState } from "./tokens"

/**
 * OpenID Connect authorization-code flow with PKCE (openid-client), against the
 * lender's own provider. The library checks the ID token's signature (the
 * provider's JWKS), issuer, audience, expiry and the nonce; this module adds the
 * lender's rules (which claims name the user, whether MFA was proven).
 *
 * The issuer URL is typed by a Super Admin, so every request to it is
 * https-only and refuses non-public addresses (as webhook URLs do) unless the
 * deployment sets SSO_ALLOW_PRIVATE_IDP=1 for an identity provider on its own
 * network. `opts` exists for tests that run a provider on loopback.
 */

export interface OidcOptions { allowInsecureHttp?: boolean; allowPrivateHosts?: boolean }

export class OidcFlowError extends Error {
  constructor(readonly code: "discovery_failed" | "state_mismatch" | "token_exchange_failed" | "no_email" | "missing_state", cause?: unknown) {
    super(code, { cause })
    this.name = "OidcFlowError"
  }
}

const REQUEST_TIMEOUT_MS = 10_000

function guardedFetch(opts: OidcOptions): client.CustomFetch {
  const privateOk = opts.allowPrivateHosts === true || process.env.SSO_ALLOW_PRIVATE_IDP === "1"
  return async (url, init) => {
    const target = new URL(url)
    if (target.protocol !== "https:" && !opts.allowInsecureHttp) throw new Error("identity provider requests must use https")
    if (!privateOk) await resolvePublic(target.hostname, systemResolver)
    return fetch(url, { ...init, body: init.body as BodyInit | null | undefined, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  }
}

async function configuration(conn: LoadedConnection, opts: OidcOptions): Promise<client.Configuration> {
  if (!conn.oidcIssuer || !conn.oidcClientId) throw new OidcFlowError("discovery_failed")
  try {
    return await client.discovery(
      new URL(conn.oidcIssuer), conn.oidcClientId, undefined, client.ClientSecretPost(openClientSecret(conn)),
      { [client.customFetch]: guardedFetch(opts), ...(opts.allowInsecureHttp ? { execute: [client.allowInsecureRequests] } : {}) },
    )
  } catch (error) {
    throw new OidcFlowError("discovery_failed", error)
  }
}

/** Where to send the browser, and the signed state to set as a cookie. */
export async function beginOidc(
  conn: LoadedConnection, args: { redirectUri: string; returnTo: string }, opts: OidcOptions = {},
): Promise<{ url: string; stateToken: string }> {
  const config = await configuration(conn, opts)
  const codeVerifier = client.randomPKCECodeVerifier()
  const state = client.randomState()
  const nonce = client.randomNonce()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: args.redirectUri,
    scope: conn.oidcScopes.join(" "),
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  })
  const flow: SsoFlowState = { tenantId: conn.tenantId, state, nonce, codeVerifier, returnTo: args.returnTo }
  return { url: url.href, stateToken: await mintState(flow) }
}

const SIGNING_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]

/**
 * OIDC Core lets a client skip the signature of an ID token received straight
 * from the token endpoint over TLS, and openid-client does. We check it anyway
 * against the provider's published keys: a bank's auditor will ask, and a
 * misdirected token endpoint then cannot mint a staff session.
 */
async function verifyIdTokenSignature(config: client.Configuration, idToken: string, opts: OidcOptions): Promise<void> {
  const meta = config.serverMetadata()
  if (!meta.jwks_uri) throw new OidcFlowError("token_exchange_failed")
  const jwks = createRemoteJWKSet(new URL(meta.jwks_uri), { [joseCustomFetch]: guardedFetch(opts) as never, timeoutDuration: REQUEST_TIMEOUT_MS })
  try {
    await jwtVerify(idToken, jwks, { issuer: meta.issuer, audience: config.clientMetadata().client_id, algorithms: SIGNING_ALGORITHMS })
  } catch (error) {
    throw new OidcFlowError("token_exchange_failed", error)
  }
}

/** Some providers send email_verified as the string "true" / "false". Anything else is "does not say". */
function verifiedFlag(value: unknown): boolean | undefined {
  if (value === true || value === "true") return true
  if (value === false || value === "false") return false
  return undefined
}

const asStringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : typeof v === "string" && v ? [v] : []

/** Exchange the code at the callback and read who signed in. Throws OidcFlowError on any failure. */
export async function completeOidc(
  conn: LoadedConnection, args: { callbackUrl: URL; flow: SsoFlowState }, opts: OidcOptions = {},
): Promise<IdpIdentity> {
  const { flow } = args
  if (flow.tenantId !== conn.tenantId || !flow.nonce || !flow.codeVerifier) throw new OidcFlowError("missing_state")
  const config = await configuration(conn, opts)
  let tokens: Awaited<ReturnType<typeof client.authorizationCodeGrant>>
  try {
    tokens = await client.authorizationCodeGrant(config, args.callbackUrl, {
      pkceCodeVerifier: flow.codeVerifier, expectedState: flow.state, expectedNonce: flow.nonce, idTokenExpected: true,
    })
  } catch (error) {
    throw new OidcFlowError(args.callbackUrl.searchParams.get("state") !== flow.state ? "state_mismatch" : "token_exchange_failed", error)
  }
  const idToken = tokens.claims()
  if (!idToken || !tokens.id_token) throw new OidcFlowError("token_exchange_failed")
  await verifyIdTokenSignature(config, tokens.id_token, opts)
  let claims: Record<string, unknown> = { ...idToken }
  // Some providers keep email and groups out of the ID token: userinfo fills the gaps (the ID token wins).
  if (claims[conn.emailClaim] === undefined || claims[conn.groupsClaim] === undefined) {
    const info = await client.fetchUserInfo(config, tokens.access_token, idToken.sub).catch((error: unknown) => {
      console.warn("[sso] userinfo request failed; continuing with the ID token's claims:", error instanceof Error ? error.message : "unknown error")
      return {}
    })
    claims = { ...info, ...claims }
  }
  const email = claims[conn.emailClaim]
  if (typeof email !== "string" || !email) throw new OidcFlowError("no_email")
  return {
    subject: `${idToken.iss}|${idToken.sub}`,
    email,
    emailVerified: verifiedFlag(claims.email_verified),
    name: typeof claims.name === "string" ? claims.name : null,
    groups: asStringList(claims[conn.groupsClaim]),
    mfaProven: oidcMfaProven({ amr: claims.amr, acr: claims.acr }, conn.mfaAcrValues),
  }
}

