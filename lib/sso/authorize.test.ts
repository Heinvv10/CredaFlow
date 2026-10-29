import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  conn: null as Record<string, unknown> | null,
  totp: { kind: "not_enrolled" } as { kind: string },
  policyRequired: true,
  access: { allowed: true } as { allowed: boolean; reason?: string },
  claims: new Set<string>(),
  failures: [] as string[],
  audits: [] as string[],
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => h.user, update: async () => ({}) },
    loginLog: { create: async () => ({}) },
  },
}))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: async (_t: string, fn: () => Promise<unknown>) => fn() }))
vi.mock("./connection", () => ({ getEnabledConnection: async () => h.conn }))
vi.mock("./cache", () => ({ claimOnce: async (k: string) => (h.claims.has(k) ? false : (h.claims.add(k), true)) }))
vi.mock("@/lib/auth-totp-step", () => ({ signInTotpOutcome: async () => h.totp }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => h.policyRequired }))
vi.mock("@/lib/security/staff-access-enforcement", () => ({ checkStaffSignIn: async () => h.access }))
vi.mock("@/lib/audit", () => ({ AuditAction: { SSO_SIGN_IN_REFUSED: "SSO_SIGN_IN_REFUSED" }, logAudit: async (p: { action: string }) => { h.audits.push(p.action) } }))

import { authorizeSso } from "./authorize"
import { mintTicket } from "./tokens"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const baseUser = { id: "u1", email: "ann@bank.example.test", name: "Ann", role: "CREDIT_OFFICER", tenantId: "t1", operatorId: null, active: true, tokenVersion: 3, totpEnabled: false, totpSecret: null, tenant: { status: "ACTIVE" } }
const call = async (ticketOver: { idpMfa?: boolean; tenantId?: string } = {}, code?: string, ticket?: string) =>
  authorizeSso({
    ticket: ticket ?? (await mintTicket({ userId: "u1", tenantId: ticketOver.tenantId ?? "t1", idpMfa: ticketOver.idpMfa ?? false })),
    code, ip: "203.0.113.9", userAgent: "ua", recordFailure: async (r) => { h.failures.push(r) },
  })

beforeEach(() => {
  process.env.AUTH_SECRET = "s".repeat(48)
  h.user = { ...baseUser }
  h.conn = { tenantId: "t1", enabled: true, trustIdpMfa: false }
  h.totp = { kind: "not_enrolled" }
  h.policyRequired = true
  h.access = { allowed: true }
  h.claims.clear(); h.failures.length = 0; h.audits.length = 0
  _resetRateLimitStore()
})

describe("authorizeSso: second factor", () => {
  it("holds a user with no TOTP at enrolment when the lender requires 2FA and the provider proved nothing", async () => {
    const out = await call({ idpMfa: false })
    expect(out).toMatchObject({ ok: true, user: { totpVerified: false, totpEnrolmentRequired: true, idpMfa: false } })
  })

  it("holds even when the provider proved MFA if the lender does not trust it", async () => {
    h.conn = { ...h.conn!, trustIdpMfa: false }
    expect(await call({ idpMfa: true })).toMatchObject({ ok: true, user: { totpEnrolmentRequired: true, idpMfa: false } })
  })

  it("lets provider MFA stand in for enrolment only when trusted AND proven, and never marks totpVerified", async () => {
    h.conn = { ...h.conn!, trustIdpMfa: true }
    expect(await call({ idpMfa: true })).toMatchObject({ ok: true, user: { totpVerified: false, totpEnrolmentRequired: false, idpMfa: true } })
  })

  it("does not trust a provider that did not prove MFA, even when trust is on", async () => {
    h.conn = { ...h.conn!, trustIdpMfa: true }
    expect(await call({ idpMfa: false })).toMatchObject({ ok: true, user: { totpEnrolmentRequired: true, idpMfa: false } })
  })

  it("does not hold a user when the lender does not require 2FA", async () => {
    h.policyRequired = false
    expect(await call({ idpMfa: false })).toMatchObject({ ok: true, user: { totpEnrolmentRequired: false } })
  })

  it("demands a code from an enrolled user, whatever the provider proved", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.conn = { ...h.conn!, trustIdpMfa: true }
    h.totp = { kind: "required" }
    expect(await call({ idpMfa: true })).toEqual({ ok: false, error: "totp_required" })
  })

  it("accepts a valid code from an enrolled user and marks totpVerified", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.totp = { kind: "verified" }
    expect(await call({}, "123456")).toMatchObject({ ok: true, user: { totpVerified: true, totpEnrolmentRequired: false, idpMfa: false } })
  })

  it.each(["invalid", "replayed", "misconfigured"])("refuses a %s code", async (kind) => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.totp = { kind }
    expect(await call({}, "000000")).toEqual({ ok: false, error: "totp_invalid" })
  })

  it("rate limits code guesses per user", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.totp = { kind: "invalid" }
    for (let i = 0; i < 10; i++) await call({}, "000000")
    expect(await call({}, "000000")).toEqual({ ok: false, error: "rate_limited" })
  })
})

describe("authorizeSso: ticket and principal", () => {
  it("spends the ticket once", async () => {
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", idpMfa: false })
    expect((await call({}, undefined, ticket)).ok).toBe(true)
    expect(await call({}, undefined, ticket)).toEqual({ ok: false, error: "refused" })
    expect(h.failures).toContain("sso_ticket_replayed")
  })

  it("does not spend the ticket when a code is still needed", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", idpMfa: false })
    h.totp = { kind: "required" }
    expect(await call({}, undefined, ticket)).toEqual({ ok: false, error: "totp_required" })
    h.totp = { kind: "verified" }
    expect((await call({}, "123456", ticket)).ok).toBe(true)
  })

  it("does not spend the ticket on a refused code", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", idpMfa: false })
    h.totp = { kind: "invalid" }
    await call({}, "000000", ticket)
    expect(h.claims.size).toBe(0)
  })

  it.each([
    ["garbage", "not-a-ticket"],
    ["empty", ""],
  ])("refuses a %s ticket", async (_l, ticket) => {
    expect(await call({}, undefined, ticket)).toEqual({ ok: false, error: "refused" })
  })

  it("refuses an inactive user and audits it", async () => {
    h.user = { ...baseUser, active: false }
    expect(await call()).toEqual({ ok: false, error: "refused" })
    expect(h.audits).toEqual(["SSO_SIGN_IN_REFUSED"])
  })

  it("refuses a SUPER_ADMIN even with a valid ticket, and audits it", async () => {
    h.user = { ...baseUser, role: "SUPER_ADMIN" }
    expect(await call()).toEqual({ ok: false, error: "refused" })
    expect(h.audits).toEqual(["SSO_SIGN_IN_REFUSED"])
    expect(h.failures).toContain("sso_super_admin")
    expect(h.claims.size).toBe(0)
  })

  it("refuses a user of a suspended lender", async () => {
    h.user = { ...baseUser, tenant: { status: "SUSPENDED" } }
    expect(await call()).toEqual({ ok: false, error: "refused" })
  })

  it("refuses a ticket whose lender is not the user's", async () => {
    expect(await call({ tenantId: "t2" })).toEqual({ ok: false, error: "refused" })
  })

  it("refuses once the lender has switched SSO off", async () => {
    h.conn = null
    expect(await call()).toEqual({ ok: false, error: "refused" })
    expect(h.failures).toContain("sso_disabled")
  })

  it("applies the lender's access policy and does not spend the ticket on a refusal", async () => {
    h.access = { allowed: false, reason: "ip_not_allowed" }
    expect(await call()).toEqual({ ok: false, error: "access_refused", reason: "ip_not_allowed" })
    expect(h.claims.size).toBe(0)
  })
})
