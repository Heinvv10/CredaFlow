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
        deleteMany: async () => ({ count: 0 }),
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

import { handleOidcCallback, handleSsoStart } from "./flow"
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
    allowedEmailDomains: ["bank.example.test", "acme-lending.example"], allowUnverifiedEmail: false, groupRoleMap: { admins: "ADMIN" }, jitProvisioning: false, jitDefaultRole: null, trustIdpMfa: false, mfaAcrValues: [], passwordLoginDisabled: false,
  }
})

/** Start, let the provider authenticate, return to the callback. */
async function signInVia(rawClaims: Record<string, unknown>, tweak: { dropCookie?: boolean; reuse?: boolean } = {}) {
  const claims = { email_verified: true, ...rawClaims }
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

  it("does not accept provider MFA unless the lender trusts it: the user is held at enrolment", async () => {
    const { cb } = await signInVia({ email: "ann@bank.example.test", amr: ["pwd", "mfa"] })
    expect(await trade(cb)).toMatchObject({ ok: true, user: { totpEnrolmentRequired: true, idpMfa: false } })
  })

  it("accepts provider MFA when the lender trusts it and the provider proved it", async () => {
    h.conn = { ...h.conn!, trustIdpMfa: true }
    const { cb } = await signInVia({ email: "ann@bank.example.test", amr: ["pwd", "mfa"] })
    expect(await trade(cb)).toMatchObject({ ok: true, user: { totpEnrolmentRequired: false, idpMfa: true, totpVerified: false } })
  })

  it("demands TOTP when the lender trusts MFA but the provider did not prove it", async () => {
    h.conn = { ...h.conn!, trustIdpMfa: true }
    const { cb } = await signInVia({ email: "ann@bank.example.test", amr: ["pwd"] })
    expect(await trade(cb)).toMatchObject({ ok: true, user: { totpEnrolmentRequired: true, idpMfa: false } })
  })

  it("asks an enrolled user for a code, whatever the provider proved, and a ticket survives the ask", async () => {
    h.users.get("ann@bank.example.test")!.totpEnabled = true
    h.users.get("ann@bank.example.test")!.totpSecret = "x"
    h.conn = { ...h.conn!, trustIdpMfa: true }
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
    const code = await idp.issueCode({ nonce: auth.searchParams.get("nonce")!, codeChallenge: auth.searchParams.get("code_challenge")!, redirectUri: "https://app.example.test/api/auth/sso/oidc/callback", claims: { email: "ann@bank.example.test", email_verified: true } })
    const cb = await handleOidcCallback(req(`/api/auth/sso/oidc/callback?code=${code}&state=${auth.searchParams.get("state")}`, cookieOf(start, flowCookieName()) ?? undefined), TEST)
    expect(new URL(cb.headers.get("location")!).searchParams.get("callbackUrl")).toBe("/dashboard")
  })
})
