import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  user: null as Record<string, unknown> | null,
  conn: null as Record<string, unknown> | null,
  totp: { kind: "not_enrolled" } as { kind: string },
  policyRequired: true,
  access: { allowed: true } as { allowed: boolean; reason?: string },
  claims: new Set<string>(),
  failures: [] as string[],
  audits: [] as Array<{ action: string; newValue?: Record<string, unknown> }>,
  updates: [] as Array<Record<string, unknown>>,
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => h.user, update: async ({ data }: { data: Record<string, unknown> }) => { h.updates.push(data); return {} } },
    loginLog: { create: async () => ({}) },
    $transaction: async (fn: (t: unknown) => unknown) => fn({ user: { update: async ({ data }: { data: Record<string, unknown> }) => { h.updates.push(data); return {} } } }),
  },
}))
vi.mock("@/lib/tenant-scope", () => ({ runWithTenant: async (_t: string, fn: () => Promise<unknown>) => fn() }))
vi.mock("./connection", () => ({ getEnabledConnection: async () => h.conn }))
vi.mock("./cache", () => ({ claimOnce: async (k: string) => (h.claims.has(k) ? false : (h.claims.add(k), true)) }))
vi.mock("@/lib/auth-totp-step", () => ({ signInTotpOutcome: async () => h.totp }))
vi.mock("@/lib/security/staff-totp-policy", () => ({ isStaffTotpRequired: async () => h.policyRequired }))
vi.mock("@/lib/security/staff-access-enforcement", () => ({ checkStaffSignIn: async () => h.access }))
vi.mock("@/lib/audit", () => {
  const record = async (p: { action: string; newValue?: Record<string, unknown> }) => { h.audits.push(p) }
  return {
    AuditAction: { SSO_SIGN_IN_REFUSED: "SSO_SIGN_IN_REFUSED", SSO_SIGN_IN_SUCCEEDED: "SSO_SIGN_IN_SUCCEEDED", SSO_ROLE_SYNCED: "SSO_ROLE_SYNCED" },
    logAudit: record, logAuditStrict: record,
  }
})

import { authorizeSso } from "./authorize"
import { mintTicket } from "./tokens"
import { _resetRateLimitStore } from "@/lib/rate-limit"

const baseUser = { id: "u1", email: "ann@bank.example.test", name: "Ann", role: "CREDIT_OFFICER", tenantId: "t1", operatorId: null, active: true, tokenVersion: 3, totpEnabled: false, totpSecret: null, tenant: { status: "ACTIVE" } }
const call = async (ticketOver: { mfaReported?: boolean; role?: "ADMIN" | "READONLY" | null; tenantId?: string } = {}, code?: string, ticket?: string) =>
  authorizeSso({
    ticket: ticket ?? (await mintTicket({ userId: "u1", tenantId: ticketOver.tenantId ?? "t1", mfaReported: ticketOver.mfaReported ?? false, role: ticketOver.role ?? null })),
    code, ip: "203.0.113.9", userAgent: "ua", recordFailure: async (r) => { h.failures.push(r) },
  })

beforeEach(() => {
  process.env.AUTH_SECRET = "s".repeat(48)
  h.user = { ...baseUser }
  h.conn = { tenantId: "t1", enabled: true, sessionHours: 10 }
  h.totp = { kind: "not_enrolled" }
  h.policyRequired = true
  h.access = { allowed: true }
  h.claims.clear(); h.failures.length = 0; h.audits.length = 0; h.updates.length = 0
  _resetRateLimitStore()
})

describe("authorizeSso: second factor (the provider never replaces CredaFlow's)", () => {
  it("holds a user with no TOTP at enrolment when the lender requires 2FA", async () => {
    expect(await call({ mfaReported: false })).toMatchObject({ ok: true, user: { totpVerified: false, totpEnrolmentRequired: true } })
  })

  it("holds an unenrolled user even when the provider reports MFA (CLAUDE.md: staff TOTP rule stands)", async () => {
    expect(await call({ mfaReported: true })).toMatchObject({ ok: true, user: { totpVerified: false, totpEnrolmentRequired: true } })
  })

  it("holds an unenrolled user whatever the connection settings say about MFA", async () => {
    h.conn = { ...h.conn!, trustIdpMfa: true, mfaAcrValues: ["urn:bank:mfa"] }
    expect(await call({ mfaReported: true })).toMatchObject({ ok: true, user: { totpEnrolmentRequired: true } })
  })

  it("does not hold a user when the lender does not require 2FA", async () => {
    h.policyRequired = false
    expect(await call({ mfaReported: false })).toMatchObject({ ok: true, user: { totpEnrolmentRequired: false } })
  })

  it("records what the provider reported, as information only", async () => {
    await call({ mfaReported: true })
    const row = h.audits.find((a) => a.action === "SSO_SIGN_IN_SUCCEEDED")!
    expect(row.newValue).toMatchObject({ providerReportedMfa: true, credaflowCodeChecked: false, heldAtEnrolment: true, sessionHours: 10 })
  })

  it("demands a code from an enrolled user, whatever the provider proved", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.conn = { ...h.conn!, trustIdpMfa: true }
    h.totp = { kind: "required" }
    expect(await call({ mfaReported: true })).toEqual({ ok: false, error: "totp_required" })
  })

  it("accepts a valid code from an enrolled user and marks totpVerified", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.totp = { kind: "verified" }
    expect(await call({}, "123456")).toMatchObject({ ok: true, user: { totpVerified: true, totpEnrolmentRequired: false } })
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

describe("authorizeSso: role from the provider's groups", () => {
  it("applies the mapped role only after every check passed, audited, and returns it", async () => {
    const out = await call({ role: "ADMIN" })
    expect(out).toMatchObject({ ok: true, user: { role: "ADMIN" } })
    expect(h.updates).toContainEqual({ role: "ADMIN" })
    expect(h.audits.map((a) => a.action)).toEqual(["SSO_ROLE_SYNCED", "SSO_SIGN_IN_SUCCEEDED"])
  })

  it("changes nothing when the role already matches or none is mapped", async () => {
    await call({ role: null })
    expect(h.updates.filter((u) => "role" in u)).toEqual([])
    expect(h.audits.map((a) => a.action)).toEqual(["SSO_SIGN_IN_SUCCEEDED"])
  })

  it("does not change the role when the sign-in is refused afterwards (TOTP wrong, access policy, inactive)", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    h.totp = { kind: "invalid" }
    await call({ role: "ADMIN" }, "000000")
    h.totp = { kind: "required" }
    await call({ role: "ADMIN" })
    h.totp = { kind: "verified" }
    h.access = { allowed: false, reason: "ip_not_allowed" }
    await call({ role: "ADMIN" }, "123456")
    h.access = { allowed: true }
    h.user = { ...baseUser, active: false }
    await call({ role: "ADMIN" })
    expect(h.updates.filter((u) => "role" in u)).toEqual([])
    expect(h.audits.map((a) => a.action)).not.toContain("SSO_ROLE_SYNCED")
  })

  it("does not apply a role from a replayed ticket", async () => {
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: "ADMIN" })
    await call({}, undefined, ticket)
    h.updates.length = 0
    expect(await call({}, undefined, ticket)).toEqual({ ok: false, error: "refused" })
    expect(h.updates).toEqual([])
  })
})

describe("authorizeSso: session lifetime", () => {
  it("stamps an absolute expiry from the lender's setting", async () => {
    h.conn = { ...h.conn!, sessionHours: 3 }
    const before = Math.floor(Date.now() / 1000)
    const out = await call()
    if (!out.ok) throw new Error("refused")
    expect(out.user.ssoSessionExp).toBeGreaterThanOrEqual(before + 3 * 3600)
    expect(out.user.ssoSessionExp).toBeLessThanOrEqual(before + 3 * 3600 + 5)
  })
})

describe("authorizeSso: ticket and principal", () => {
  it("spends the ticket once", async () => {
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: null })
    expect((await call({}, undefined, ticket)).ok).toBe(true)
    expect(await call({}, undefined, ticket)).toEqual({ ok: false, error: "refused" })
    expect(h.failures).toContain("sso_ticket_replayed")
  })

  it("does not spend the ticket when a code is still needed", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: null })
    h.totp = { kind: "required" }
    expect(await call({}, undefined, ticket)).toEqual({ ok: false, error: "totp_required" })
    h.totp = { kind: "verified" }
    expect((await call({}, "123456", ticket)).ok).toBe(true)
  })

  it("does not spend the ticket on a refused code", async () => {
    h.user = { ...baseUser, totpEnabled: true, totpSecret: "x" }
    const ticket = await mintTicket({ userId: "u1", tenantId: "t1", mfaReported: false, role: null })
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
    expect(h.audits.map((a) => a.action)).toEqual(["SSO_SIGN_IN_REFUSED"])
  })

  it("refuses a SUPER_ADMIN even with a valid ticket, and audits it", async () => {
    h.user = { ...baseUser, role: "SUPER_ADMIN" }
    expect(await call()).toEqual({ ok: false, error: "refused" })
    expect(h.audits.map((a) => a.action)).toEqual(["SSO_SIGN_IN_REFUSED"])
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
