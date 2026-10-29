import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => {
  type U = { id: string; email: string; name: string | null; role: string; tenantId: string | null; operatorId: string | null; active: boolean; tokenVersion: number; totpEnabled: boolean; totpSecret: string | null }
  return {
    users: new Map<string, U>(),
    failures: [] as string[],
    audits: [] as string[],
    cache: new Map<string, { value: string; expiresAt: Date }>(),
    links: [] as Array<{ tenantId: string; userId: string; subject: string }>,
    conn: null as Record<string, unknown> | null,
    totp: { kind: "not_enrolled" } as { kind: string },
  }
})

vi.mock("@/lib/prisma", () => {
  const tx = {
    user: {
      findUnique: async ({ where }: { where: { email?: string; id?: string } }) =>
        where.email ? h.users.get(where.email) ?? null : [...h.users.values()].find((u) => u.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign([...h.users.values()].find((u) => u.id === where.id)!, data),
    },
    ssoIdentity: {
      findFirst: async ({ where }: { where: { subject?: string; userId?: string } }) =>
        h.links.find((l) => (where.subject === undefined || l.subject === where.subject) && (where.userId === undefined || l.userId === where.userId)) ?? null,
      create: async ({ data }: { data: { tenantId: string; userId: string; subject: string } }) => { h.links.push(data); return data },
    },
    auditLog: { create: async ({ data }: { data: { action: string } }) => { h.audits.push(data.action) } },
  }
  return {
    prisma: {
      ...tx,
      $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
      failedLoginAttempt: { create: async ({ data }: { data: { reason: string } }) => { h.failures.push(data.reason) } },
      loginLog: { create: async () => ({}) },
      ssoCacheEntry: {
        create: async ({ data }: { data: { key: string; value: string; expiresAt: Date } }) => {
          if (h.cache.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" })
          h.cache.set(data.key, data)
        },
        findUnique: async ({ where }: { where: { key: string } }) => h.cache.get(where.key) ? { key: where.key, ...h.cache.get(where.key)! } : null,
        deleteMany: async ({ where }: { where: { key?: string; expiresAt?: { lt: Date } } }) => {
          const row = where.key === undefined ? undefined : h.cache.get(where.key)
          const due = row !== undefined && (!where.expiresAt || row.expiresAt < where.expiresAt.lt)
          if (due) h.cache.delete(where.key as string)
          return { count: due ? 1 : 0 }
        },
      },
    },
  }
})
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async (req: Request) => (req.headers.get("host") === "app.example.test" ? { id: "t1", slug: "acme" } : null) }))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: async (_t: string, fn: () => Promise<unknown>) => fn() }))
vi.mock("./connection", async (orig) => ({ ...(await orig<typeof import("./connection")>()), getEnabledConnection: async () => h.conn }))
vi.mock("@/lib/auth-totp-step", () => ({ signInTotpOutcome: async () => h.totp }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => true }))
vi.mock("@/lib/security/staff-access-enforcement", () => ({ checkStaffSignIn: async () => ({ allowed: true }) }))
vi.mock("@/lib/audit", () => ({
  AuditAction: { SSO_SIGN_IN_REFUSED: "SSO_SIGN_IN_REFUSED", SSO_ROLE_SYNCED: "SSO_ROLE_SYNCED", SSO_USER_PROVISIONED: "SSO_USER_PROVISIONED" },
  logAudit: async (p: { action: string }) => { h.audits.push(p.action) },
  logAuditStrict: async (p: { action: string }) => { h.audits.push(p.action) },
}))

import { handleOidcCallback, handleSamlAcs, handleSamlMetadata, handleSsoStart } from "./flow"
import { readState } from "./tokens"
import { samlResponse, testCertificatePem } from "./test-support/saml-fixture"
import { authorizeSso } from "./authorize"
import { sealSecret } from "@/lib/crypto/secret-box"
import { startMockIdp, type MockIdp } from "./test-support/mock-oidc-idp"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { flowCookieName, ticketCookieName } from "./cookies"

const KEY = Buffer.alloc(32, 9).toString("base64")
const TEST = { allowInsecureHttp: true, allowPrivateHosts: true }
let idp: MockIdp

beforeAll(async () => {
  process.env.SSO_SECRET_KEY = KEY
  process.env.AUTH_SECRET = "s".repeat(48)
  process.env.NEXTAUTH_URL = "https://app.example.test"
  delete process.env.AUTH_URL
  delete process.env.APP_MODE
  idp = await startMockIdp()
})
afterAll(() => idp.close())

const req = (path: string, cookie?: string, host = "app.example.test") =>
  new Request(`https://${host}${path}`, { headers: { host, ...(cookie ? { cookie } : {}) } })
const cookieOf = (res: Response, name: string) => {
  const line = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return line ? line.split(";")[0] : null
}

beforeEach(() => {
  _resetRateLimitStore()
  h.users.clear(); h.failures.length = 0; h.audits.length = 0; h.cache.clear(); h.links.length = 0; h.totp = { kind: "not_enrolled" }
  h.users.set("ann@bank.example.test", { id: "u1", email: "ann@bank.example.test", name: "Ann", role: "CREDIT_OFFICER", tenantId: "t1", operatorId: null, active: true, tokenVersion: 0, totpEnabled: false, totpSecret: null })
  h.conn = {
    id: "c1", tenantId: "t1", protocol: "OIDC", enabled: true, oidcIssuer: idp.issuer, oidcClientId: idp.clientId,
    oidcClientSecretSealed: sealSecret(idp.clientSecret, KEY), oidcScopes: ["openid", "email", "profile"], emailClaim: "email", groupsClaim: "groups",
    allowedEmailDomains: ["bank.example.test", "acme-lending.example"], allowUnverifiedEmail: false, groupRoleMap: { admins: "ADMIN", officers: "CREDIT_OFFICER" }, jitProvisioning: false, jitDefaultRole: null, mfaAcrValues: [], passwordLoginDisabled: false, sessionHours: 10,
  }
})

/** Start, let the provider authenticate, return to the callback. */
async function signInVia(rawClaims: Record<string, unknown>, tweak: { dropCookie?: boolean; reuse?: boolean } = {}) {
  const claims = { email_verified: true, groups: ["officers"], ...rawClaims }
  const start = await handleSsoStart(req("/api/auth/sso/start?callbackUrl=/loans"), TEST)
  const auth = new URL(start.headers.get("location")!)
  const flow = cookieOf(start, flowCookieName())
  const code = await idp.issueCode({
    nonce: auth.searchParams.get("nonce")!, codeChallenge: auth.searchParams.get("code_challenge")!,
    redirectUri: "https://app.example.test/api/auth/sso/oidc/callback", claims,
  })
  const qs = `?code=${code}&state=${auth.searchParams.get("state")}`
  const cb = await handleOidcCallback(req(`/api/auth/sso/oidc/callback${qs}`, tweak.dropCookie ? undefined : flow ?? undefined), TEST)
  const second = tweak.reuse ? await handleOidcCallback(req(`/api/auth/sso/oidc/callback${qs}`, flow ?? undefined), TEST) : null
  return { start, flow, cb, second }
}

const trade = (cb: Response, code?: string) =>
  authorizeSso({ ticket: decodeURIComponent(cookieOf(cb, ticketCookieName())!.split("=")[1]), code, ip: "203.0.113.9", userAgent: "ua", recordFailure: async (r) => { h.failures.push(r) } })

describe("SSO sign-in, end to end against a local OIDC provider", () => {
  it("leaves for the provider with a signed flow cookie that scripts cannot read", async () => {
    const start = await handleSsoStart(req("/api/auth/sso/start"), TEST)
    expect(start.status).toBe(303)
    expect(start.headers.get("location")!.startsWith(`${idp.issuer}/authorize?`)).toBe(true)
    const line = start.headers.getSetCookie().find((c) => c.startsWith(`${flowCookieName()}=`))!
    expect(line).toMatch(/HttpOnly/i)
    expect(line).toMatch(/Secure/i)
  })

  it("signs a mapped user in: ticket cookie, then a session whose role follows the group", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test", groups: ["admins"], amr: ["pwd", "mfa"] })
    expect(cb.status).toBe(303)
    const loc = new URL(cb.headers.get("location")!)
    expect(loc.pathname).toBe("/login")
    expect(loc.searchParams.get("sso")).toBe("1")
    expect(loc.searchParams.get("callbackUrl")).toBe("/loans")
    const out = await trade(cb)
    expect(out).toMatchObject({ ok: true, user: { id: "u1", role: "ADMIN", totpVerified: false } })
    expect(h.audits).toContain("SSO_ROLE_SYNCED")
  })

  it("holds an unenrolled user at enrolment even when the provider reports MFA (the TOTP rule stands)", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test", amr: ["pwd", "mfa"] })
    expect(await trade(cb)).toMatchObject({ ok: true, user: { totpEnrolmentRequired: true, totpVerified: false } })
  })

  it("applies the group's role only at the trade, and ends the session after the configured hours", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test", groups: ["admins"] })
    expect(h.users.get("ann@bank.example.test")!.role).toBe("CREDIT_OFFICER")
    const out = await trade(cb)
    expect(out).toMatchObject({ ok: true, user: { role: "ADMIN" } })
    expect(h.users.get("ann@bank.example.test")!.role).toBe("ADMIN")
    if (out.ok) expect(out.user.ssoSessionExp).toBeGreaterThan(Date.now() / 1000 + 9 * 3600)
  })

  it("refuses a user whose groups no longer map to a role", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test", groups: ["nobody"] })
    expect(cb.status).toBe(303)
    expect(new URL(cb.headers.get("location")!).searchParams.get("sso_error")).toBe("sso_refused")
    expect(h.failures).toContain("sso_no_mapped_group")
  })

  it("asks an enrolled user for a code, whatever the provider proved, and a ticket survives the ask", async () => {
    h.users.get("ann@bank.example.test")!.totpEnabled = true
    h.users.get("ann@bank.example.test")!.totpSecret = "x"
    const { cb } = await signInVia({ email: "ann@bank.example.test", amr: ["pwd", "mfa"] })
    h.totp = { kind: "required" }
    expect(await trade(cb)).toEqual({ ok: false, error: "totp_required" })
    h.totp = { kind: "verified" }
    expect(await trade(cb, "123456")).toMatchObject({ ok: true, user: { totpVerified: true } })
  })

  it("lands a ticket exactly once", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test" })
    expect((await trade(cb)).ok).toBe(true)
    expect(await trade(cb)).toEqual({ ok: false, error: "refused" })
  })
})

describe("SSO sign-in refusals", () => {
  const refused = (res: Response) => {
    expect(res.status).toBe(303)
    const loc = new URL(res.headers.get("location")!)
    expect(loc.pathname).toBe("/login")
    expect(loc.searchParams.get("sso_error")).toBe("sso_refused")
    expect(cookieOf(res, ticketCookieName())).toBeNull()
  }

  it("refuses an email that is not a staff user, and does not create one", async () => {
    const { cb } = await signInVia({ email: "stranger@bank.example.test" })
    refused(cb)
    expect(h.failures).toContain("sso_no_account")
    expect(h.users.size).toBe(1)
  })

  it("refuses a callback without the flow cookie (a forged or cross-browser callback)", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test" }, { dropCookie: true })
    refused(cb)
    expect(h.failures).toContain("sso_no_flow")
  })

  it("refuses a code used twice", async () => {
    const { second } = await signInVia({ email: "ann@bank.example.test" }, { reuse: true })
    refused(second!)
  })

  it("refuses when the lender has not enabled SSO", async () => {
    h.conn = null
    refused(await handleSsoStart(req("/api/auth/sso/start"), TEST))
    expect(h.failures).toContain("sso_not_enabled")
  })

  it("refuses an unknown host", async () => {
    refused(await handleSsoStart(req("/api/auth/sso/start", undefined, "other.example.test"), TEST))
    expect(h.failures).toContain("sso_no_tenant")
  })

  it("refuses a provider-reported error", async () => {
    const start = await handleSsoStart(req("/api/auth/sso/start"), TEST)
    refused(await handleOidcCallback(req("/api/auth/sso/oidc/callback?error=access_denied", cookieOf(start, flowCookieName()) ?? undefined), TEST))
    expect(h.failures).toContain("sso_provider_error")
  })

  it("refuses an email outside the allowed domains", async () => {
    h.conn = { ...h.conn!, allowedEmailDomains: ["other.test"] }
    const { cb } = await signInVia({ email: "ann@bank.example.test" })
    refused(cb)
    expect(h.failures).toContain("sso_domain_not_allowed")
  })

  it("refuses an email the provider did not verify, and one it did not mention", async () => {
    refused((await signInVia({ email: "ann@bank.example.test", email_verified: false })).cb)
    refused((await signInVia({ email: "ann@bank.example.test", email_verified: undefined })).cb)
    expect(h.failures.filter((f) => f === "sso_email_unverified")).toHaveLength(2)
    expect(h.links).toHaveLength(0)
  })

  it("refuses a different provider subject that claims a bound user's email (account takeover)", async () => {
    const first = await signInVia({ email: "ann@bank.example.test" })
    expect(first.cb.headers.getSetCookie().some((c) => c.startsWith(ticketCookieName()))).toBe(true)
    expect(h.links).toHaveLength(1)
    const sub = h.links[0].subject
    h.links[0].subject = `${idp.issuer}|someone-else`
    refused((await signInVia({ email: "ann@bank.example.test" })).cb)
    expect(h.failures).toContain("sso_subject_mismatch")
    h.links[0].subject = sub
  })

  it("refuses a Super Admin at the callback", async () => {
    h.users.get("ann@bank.example.test")!.role = "SUPER_ADMIN"
    refused((await signInVia({ email: "ann@bank.example.test" })).cb)
    expect(h.failures).toContain("sso_super_admin_password_only")
  })

  it("is not served on the client portal host", async () => {
    process.env.APP_MODE = "client"
    try {
      expect((await handleSsoStart(req("/api/auth/sso/start"), TEST)).status).toBe(404)
    } finally {
      delete process.env.APP_MODE
    }
  })

  it("never lands on an external URL after sign-in", async () => {
    const start = await handleSsoStart(req("/api/auth/sso/start?callbackUrl=https://evil.example.test/x"), TEST)
    const auth = new URL(start.headers.get("location")!)
    const code = await idp.issueCode({ nonce: auth.searchParams.get("nonce")!, codeChallenge: auth.searchParams.get("code_challenge")!, redirectUri: "https://app.example.test/api/auth/sso/oidc/callback", claims: { email: "ann@bank.example.test", email_verified: true, groups: ["officers"] } })
    const cb = await handleOidcCallback(req(`/api/auth/sso/oidc/callback?code=${code}&state=${auth.searchParams.get("state")}`, cookieOf(start, flowCookieName()) ?? undefined), TEST)
    expect(new URL(cb.headers.get("location")!).searchParams.get("callbackUrl")).toBe("/dashboard")
  })
})

describe("SAML service provider metadata", () => {
  const samlConn = () => ({
    ...h.conn!, protocol: "SAML", samlEntityId: "urn:cf:t1", samlIdpEntityId: "https://idp.example.test/saml",
    samlIdpSsoUrl: "https://idp.example.test/sso", samlIdpCert: "x", samlSubjectAttribute: null,
  })

  it("serves the entity id and ACS URL while SAML is on", async () => {
    h.conn = samlConn()
    const res = await handleSamlMetadata(req("/api/auth/sso/saml/metadata"))
    expect(res.status).toBe(200)
    const xml = await res.text()
    expect(xml).toContain("urn:cf:t1")
    expect(xml).toContain("https://app.example.test/api/auth/sso/saml/acs")
  })

  it("is not found for OIDC, for a disabled connection and for an unknown host", async () => {
    expect((await handleSamlMetadata(req("/api/auth/sso/saml/metadata"))).status).toBe(404)
    h.conn = null
    expect((await handleSamlMetadata(req("/api/auth/sso/saml/metadata"))).status).toBe(404)
    h.conn = samlConn()
    expect((await handleSamlMetadata(req("/api/auth/sso/saml/metadata", undefined, "other.example.test"))).status).toBe(404)
  })
})

describe("SAML ACS", () => {
  const ACS_URL = "https://app.example.test/api/auth/sso/saml/acs"
  const samlConn = () => ({
    ...h.conn!, protocol: "SAML", samlEntityId: "urn:cf:t1", samlIdpEntityId: "https://idp.example.test/saml",
    samlIdpSsoUrl: "https://idp.example.test/sso", samlIdpCert: testCertificatePem(), samlSubjectAttribute: null,
  })
  const post = (flow: string | null, fields: Record<string, string>) => {
    const body = new URLSearchParams(fields)
    return handleSamlAcs(new Request(ACS_URL, {
      method: "POST", body,
      headers: { host: "app.example.test", "content-type": "application/x-www-form-urlencoded", ...(flow ? { cookie: flow } : {}) },
    }))
  }
  const begin = async () => {
    const start = await handleSsoStart(req("/api/auth/sso/start"), TEST)
    const flow = cookieOf(start, flowCookieName())!
    const state = (await readState(decodeURIComponent(flow.split("=")[1])))!
    return { flow, state, relay: new URL(start.headers.get("location")!).searchParams.get("RelayState")! }
  }
  const refusedWith = (res: Response, reason: string) => {
    expect(new URL(res.headers.get("location")!).searchParams.get("sso_error")).toBe("sso_refused")
    expect(h.failures).toContain(reason)
  }

  it("signs a mapped user in end to end: ticket cookie, then the trade", async () => {
    h.conn = samlConn()
    const { flow, state, relay } = await begin()
    const res = await post(flow, {
      RelayState: relay,
      SAMLResponse: samlResponse({ inResponseTo: state.requestId, attributes: { email: "ann@bank.example.test", groups: ["officers"] }, nameId: "persistent-ann" }),
    })
    expect(res.status).toBe(303)
    expect(new URL(res.headers.get("location")!).searchParams.get("sso")).toBe("1")
    expect(await trade(res)).toMatchObject({ ok: true, user: { id: "u1" } })
    expect(h.links).toEqual([{ tenantId: "t1", userId: "u1", subject: "https://idp.example.test/saml|persistent-ann" }])
  })

  it("refuses a response larger than the cap, before parsing it", async () => {
    h.conn = samlConn()
    const { flow, relay } = await begin()
    refusedWith(await post(flow, { RelayState: relay, SAMLResponse: "A".repeat(400_001) }), "sso_bad_response")
  })

  it("accepts one just under the cap as far as size goes (then fails on content, not size)", async () => {
    h.conn = samlConn()
    const { flow, relay } = await begin()
    refusedWith(await post(flow, { RelayState: relay, SAMLResponse: "A".repeat(399_999) }), "sso_invalid_response")
  })

  it("refuses a missing response and a callback with no flow cookie", async () => {
    h.conn = samlConn()
    const { flow, relay } = await begin()
    refusedWith(await post(flow, { RelayState: relay }), "sso_bad_response")
    h.failures.length = 0
    refusedWith(await post(null, { RelayState: relay, SAMLResponse: "x" }), "sso_no_flow")
  })

  it("is not served for an OIDC lender", async () => {
    const { flow } = await (async () => { h.conn = samlConn(); return begin() })()
    h.conn = { ...h.conn!, protocol: "OIDC" }
    refusedWith(await post(flow, { RelayState: "r", SAMLResponse: "x" }), "sso_no_flow")
  })
})
