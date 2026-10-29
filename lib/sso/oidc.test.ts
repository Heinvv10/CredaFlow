import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { sealSecret } from "@/lib/crypto/secret-box"
import { beginOidc, completeOidc, OidcFlowError } from "./oidc"
import { readState } from "./tokens"
import { startMockIdp, type MockIdp } from "./test-support/mock-oidc-idp"
import type { LoadedConnection } from "./connection"

const KEY = Buffer.alloc(32, 7).toString("base64")
const REDIRECT = "https://app.example.test/api/auth/sso/oidc/callback"
const TEST = { allowInsecureHttp: true, allowPrivateHosts: true }

let idp: MockIdp
let wrongIssuerIdp: MockIdp
beforeAll(async () => {
  process.env.SSO_SECRET_KEY = KEY
  process.env.AUTH_SECRET = "s".repeat(48)
  idp = await startMockIdp()
  wrongIssuerIdp = await startMockIdp("https://evil.example.test")
})
afterAll(async () => { await idp.close(); await wrongIssuerIdp.close() })

const connFor = (p: MockIdp, over: Partial<LoadedConnection> = {}) => ({
  tenantId: "t1", protocol: "OIDC", enabled: true, oidcIssuer: p.issuer, oidcClientId: p.clientId,
  oidcClientSecretSealed: sealSecret(p.clientSecret, KEY), oidcScopes: ["openid", "email", "profile"],
  emailClaim: "email", groupsClaim: "groups", mfaAcrValues: [], ...over,
}) as LoadedConnection

/** Play the browser: begin, let the provider issue a code, come back to the callback. */
async function run(opts: Partial<Parameters<MockIdp["issueCode"]>[0]> = {}, conn = connFor(idp), tamper?: (cb: URL) => void) {
  const { url, stateToken } = await beginOidc(conn, { redirectUri: REDIRECT, returnTo: "/dashboard" }, TEST)
  const auth = new URL(url)
  const code = await idp.issueCode({
    nonce: auth.searchParams.get("nonce")!, codeChallenge: auth.searchParams.get("code_challenge")!, redirectUri: REDIRECT, ...opts,
  })
  const callback = new URL(REDIRECT)
  callback.searchParams.set("code", code)
  callback.searchParams.set("state", auth.searchParams.get("state")!)
  callback.searchParams.set("iss", idp.issuer)
  tamper?.(callback)
  const flow = await readState(stateToken)
  return completeOidc(conn, { callbackUrl: callback, flow: flow! }, TEST)
}

const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as OidcFlowError | null

beforeEach(() => { for (const k of Object.keys(idp.userinfo)) delete idp.userinfo[k] })

describe("OIDC sign-in against a local provider", () => {
  it("sends PKCE, state and nonce to the provider", async () => {
    const { url } = await beginOidc(connFor(idp), { redirectUri: REDIRECT, returnTo: "/" }, TEST)
    const q = new URL(url).searchParams
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("response_type")).toBe("code")
    expect(q.get("scope")).toBe("openid email profile")
    expect(q.get("state")).toBeTruthy()
    expect(q.get("nonce")).toBeTruthy()
    expect(q.get("client_id")).toBe(idp.clientId)
  })

  it("reads email, name, groups and MFA from the ID token", async () => {
    const who = await run({ claims: { email: "ann@bank.example.test", name: "Ann", groups: ["admins"], amr: ["pwd", "mfa"], email_verified: true } })
    expect(who).toEqual({ subject: `${idp.issuer}|user-1`, email: "ann@bank.example.test", emailVerified: true, name: "Ann", groups: ["admins"], mfaProven: true })
  })

  it("reports a missing email_verified as unknown, never as verified", async () => {
    expect((await run({ claims: { email: "ann@bank.example.test" } })).emailVerified).toBeUndefined()
    expect((await run({ claims: { email: "ann@bank.example.test", email_verified: false } })).emailVerified).toBe(false)
  })

  it("accepts email_verified sent as the string true, and treats the string false as false", async () => {
    expect((await run({ claims: { email: "a@b.test", email_verified: "true" } })).emailVerified).toBe(true)
    expect((await run({ claims: { email: "a@b.test", email_verified: "false" } })).emailVerified).toBe(false)
    expect((await run({ claims: { email: "a@b.test", email_verified: "yes" } })).emailVerified).toBeUndefined()
  })

  it("does not claim MFA when the provider did not prove it", async () => {
    expect((await run({ claims: { email: "ann@bank.example.test", amr: ["pwd"] } })).mfaProven).toBe(false)
    expect((await run({ claims: { email: "ann@bank.example.test" } })).mfaProven).toBe(false)
  })

  it("honours the lender's own acr value for MFA", async () => {
    const conn = connFor(idp, { mfaAcrValues: ["urn:bank:mfa"] })
    expect((await run({ claims: { email: "a@b.test", acr: "urn:bank:mfa" } }, conn)).mfaProven).toBe(true)
  })

  it("falls back to userinfo for a claim the ID token lacks", async () => {
    idp.userinfo.email = "ann@bank.example.test"
    idp.userinfo.groups = ["staff"]
    const who = await run({ claims: {} })
    expect(who).toMatchObject({ email: "ann@bank.example.test", groups: ["staff"] })
  })

  it("uses the lender's configured claim names", async () => {
    const conn = connFor(idp, { emailClaim: "upn", groupsClaim: "roles" })
    expect(await run({ claims: { upn: "ann@bank.example.test", roles: "admins" } }, conn)).toMatchObject({ email: "ann@bank.example.test", groups: ["admins"] })
  })
})

describe("OIDC refusals", () => {
  it("refuses an ID token from another issuer", async () => {
    expect((await failure(run({ issuer: "https://evil.example.test", claims: { email: "a@b.test" } })))?.code).toBe("token_exchange_failed")
  })

  it("refuses a provider whose metadata names another issuer", async () => {
    const e = await failure(beginOidc(connFor(wrongIssuerIdp), { redirectUri: REDIRECT, returnTo: "/" }, TEST))
    expect(e?.code).toBe("discovery_failed")
  })

  it("refuses a symmetric (HS256) ID token signed with the client secret: only the provider's asymmetric keys count", async () => {
    expect((await failure(run({ hmacSign: true, claims: { email: "a@b.test" } })))?.code).toBe("token_exchange_failed")
  })

  it("lets the ID token's claims win over userinfo's, and fills only what the ID token lacks", async () => {
    idp.userinfo.email = "userinfo-says-otherwise@bank.example.test"
    idp.userinfo.groups = ["from-userinfo"]
    idp.userinfo.name = "Userinfo Name"
    // No groups in the ID token, so userinfo is consulted: its email must not displace the ID token's.
    const who = await run({ claims: { email: "idtoken@bank.example.test", name: "Id Token Name" } })
    expect(who).toMatchObject({ email: "idtoken@bank.example.test", name: "Id Token Name", groups: ["from-userinfo"] })
  })

  it("refuses an ID token for another client", async () => {
    expect((await failure(run({ audience: "someone-else", claims: { email: "a@b.test" } })))?.code).toBe("token_exchange_failed")
  })

  it("refuses an expired ID token", async () => {
    expect((await failure(run({ expiresInSeconds: -3600, claims: { email: "a@b.test" } })))?.code).toBe("token_exchange_failed")
  })

  it("refuses a wrong nonce", async () => {
    expect((await failure(run({ nonceClaim: "other-nonce", claims: { email: "a@b.test" } })))?.code).toBe("token_exchange_failed")
  })

  it("refuses an ID token signed by a key the provider does not publish", async () => {
    expect((await failure(run({ signWithOtherKey: true, claims: { email: "a@b.test" } })))?.code).toBe("token_exchange_failed")
  })

  it("refuses a callback whose state is not the one sent", async () => {
    expect((await failure(run({ claims: { email: "a@b.test" } }, connFor(idp), (cb) => cb.searchParams.set("state", "forged"))))?.code).toBe("state_mismatch")
  })

  it("refuses a callback with no code", async () => {
    expect(await failure(run({ claims: { email: "a@b.test" } }, connFor(idp), (cb) => cb.searchParams.delete("code")))).toBeInstanceOf(OidcFlowError)
  })

  it("refuses a response with no ID token", async () => {
    expect(await failure(run({ omitIdToken: true }))).toBeInstanceOf(OidcFlowError)
  })

  it("refuses an identity with no email", async () => {
    expect((await failure(run({ claims: {} })))?.code).toBe("no_email")
  })

  it("refuses a flow state from another lender", async () => {
    const { url, stateToken } = await beginOidc(connFor(idp), { redirectUri: REDIRECT, returnTo: "/" }, TEST)
    const flow = (await readState(stateToken))!
    const e = await failure(completeOidc(connFor(idp, { tenantId: "t2" }), { callbackUrl: new URL(url), flow }, TEST))
    expect(e?.code).toBe("missing_state")
  })

  it("refuses a provider on a private address by default", async () => {
    const e = await failure(beginOidc(connFor(idp), { redirectUri: REDIRECT, returnTo: "/" }, { allowInsecureHttp: true }))
    expect(e?.code).toBe("discovery_failed")
  })
})
