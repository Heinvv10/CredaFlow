import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { _resetRateLimitStore } from "../rate-limit"

/**
 * Staff working hours and IP allowlist, through the real authorize() and jwt
 * callback of lib/auth.ts (next-auth replaced by a recorder, as in
 * auth-client-session.test.ts). Prisma is mocked; the policy logic is not.
 */
interface CapturedConfig {
  callbacks: { jwt: (args: Record<string, unknown>) => Promise<unknown> }
  providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>
}

const { mocks, captured, requestHeaders } = vi.hoisted(() => ({
  mocks: {
    userFindUnique: vi.fn(),
    tenantConfigFindUnique: vi.fn(),
    failedAttemptCreate: vi.fn(),
    loginLogCreate: vi.fn(),
    auditCreate: vi.fn(),
    bcryptCompare: vi.fn(),
    totpOutcome: vi.fn(),
  },
  captured: { config: undefined as undefined | CapturedConfig },
  requestHeaders: { value: new Headers() },
}))

vi.mock("next-auth", () => ({
  default: vi.fn((config: CapturedConfig) => {
    captured.config = config
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }
  }),
  CredentialsSignin: class {},
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (config: unknown) => config }))
vi.mock("next/headers", () => ({ headers: async () => requestHeaders.value }))
vi.mock("@/lib/tenant-scope", () => ({ withoutTenantScope: <T,>(fn: () => Promise<T>) => fn() }))
vi.mock("bcryptjs", () => ({ default: { compare: (...a: unknown[]) => mocks.bcryptCompare(...a), hashSync: () => "dummy-hash" } }))
vi.mock("@/lib/auth-totp-step", () => ({ signInTotpOutcome: (...a: unknown[]) => mocks.totpOutcome(...a) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mocks.userFindUnique, update: vi.fn(async () => ({})), updateMany: vi.fn() },
    client: { findFirst: vi.fn(), findUnique: vi.fn() },
    failedLoginAttempt: { create: mocks.failedAttemptCreate },
    loginLog: { create: mocks.loginLogCreate },
    tenantConfig: { findUnique: mocks.tenantConfigFindUnique },
    auditLog: { create: mocks.auditCreate },
  },
}))

import "../auth"
import { resetSecurityEventWindows } from "../audit/security-events"

const jwt = (args: Record<string, unknown>) => captured.config!.callbacks.jwt(args)
const signInFrom = (ip: string) =>
  captured.config!.providers[0].authorize(
    { email: "officer@example.test", password: "pw", loginType: "staff" },
    new Request("http://localhost/api/auth/callback/credentials", { headers: { "x-forwarded-for": ip } }),
  )

const MON_TO_FRI = {
  mon: { start: "08:00", end: "17:00" }, tue: { start: "08:00", end: "17:00" }, wed: { start: "08:00", end: "17:00" },
  thu: { start: "08:00", end: "17:00" }, fri: { start: "08:00", end: "17:00" }, sat: null, sun: null,
}
const policy = { staffAccessHours: MON_TO_FRI, staffIpAllowlist: ["192.0.2.0/24", "2001:db8::/32"] }
const staffRow = (role = "CREDIT_OFFICER") => ({
  id: "u1", email: "officer@example.test", name: "Officer", password: "hash", active: true,
  tenantId: "t1", role, tokenVersion: 0, totpEnabled: false, totpSecret: null,
})
const staffToken = (role = "CREDIT_OFFICER") => ({
  id: "u1", email: "officer@example.test", role, tenantId: "t1", tokenVersion: 0, totpEnrolmentRequired: false,
})

// Monday 2026-10-12. 10:00 SAST = 08:00Z; 18:30 SAST = 16:30Z.
const IN_HOURS = new Date("2026-10-12T08:00:00.000Z")
const AFTER_HOURS = new Date("2026-10-12T16:30:00.000Z")

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(IN_HOURS)
  vi.stubEnv("TRUSTED_PROXY", "1")
  vi.stubEnv("APP_MODE", "")
  _resetRateLimitStore()
  for (const m of Object.values(mocks)) m.mockReset().mockResolvedValue({})
  mocks.bcryptCompare.mockResolvedValue(true)
  mocks.totpOutcome.mockResolvedValue({ kind: "not_enrolled" })
  resetSecurityEventWindows()
  mocks.tenantConfigFindUnique.mockResolvedValue({ ...policy, requireStaffTotp: false })
  requestHeaders.value = new Headers({ "x-forwarded-for": "192.0.2.44" })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

const allAuditActions = () => mocks.auditCreate.mock.calls.map((c) => (c[0] as { data: { action: string } }).data.action)
// The staff-access policy's own rows; the sign-in's SECURITY_* rows (lib/audit/security-events.ts) are asserted apart.
const auditActions = () => allAuditActions().filter((a) => !a.startsWith("SECURITY_"))

describe("sign-in", () => {
  it("lets an in-hours staff member from an allowed network sign in", async () => {
    mocks.userFindUnique.mockResolvedValue(staffRow())
    await expect(signInFrom("192.0.2.10")).resolves.toMatchObject({ id: "u1" })
    expect(auditActions()).toEqual([])
    expect(allAuditActions()).toEqual(["SECURITY_LOGIN_SUCCEEDED"])
  })

  it("refuses outside working hours and records the reason everywhere a failed sign-in goes", async () => {
    vi.setSystemTime(AFTER_HOURS)
    mocks.userFindUnique.mockResolvedValue(staffRow())

    await expect(signInFrom("192.0.2.10")).rejects.toMatchObject({ code: "access_outside_hours" })
    expect(mocks.failedAttemptCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ reason: "access_outside_hours", ip: "192.0.2.10" }),
    })
    expect(mocks.loginLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ success: false, userId: "u1" }) })
    expect(mocks.loginLogCreate).not.toHaveBeenCalledWith({ data: expect.objectContaining({ success: true }) })
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "STAFF_ACCESS_REFUSED",
        entityId: "u1",
        newValue: expect.objectContaining({ reason: "outside_hours", stage: "sign_in" }),
      }),
    })
  })

  it("refuses a network outside the allowlist, IPv4 and IPv6 alike", async () => {
    mocks.userFindUnique.mockResolvedValue(staffRow())
    await expect(signInFrom("198.51.100.1")).rejects.toMatchObject({ code: "access_ip_not_allowed" })
    await expect(signInFrom("2001:db9::1")).rejects.toMatchObject({ code: "access_ip_not_allowed" })
    await expect(signInFrom("2001:db8:1::1")).resolves.toMatchObject({ id: "u1" })
  })

  it("reads the caller from the trusted proxy hop, not a spoofed left-most X-Forwarded-For", async () => {
    mocks.userFindUnique.mockResolvedValue(staffRow())
    // TRUSTED_PROXY=1: the right-most entry is what our proxy saw.
    await expect(signInFrom("192.0.2.10, 198.51.100.1")).rejects.toMatchObject({ code: "access_ip_not_allowed" })
    await expect(signInFrom("198.51.100.1, 192.0.2.10")).resolves.toMatchObject({ id: "u1" })
  })

  it("refuses everyone but a Super Admin when no trusted proxy reports the caller", async () => {
    vi.stubEnv("TRUSTED_PROXY", "0")
    mocks.userFindUnique.mockResolvedValue(staffRow())
    await expect(signInFrom("192.0.2.10")).rejects.toMatchObject({ code: "access_ip_not_allowed" })
  })

  it("lets a Super Admin through after hours and off-network, and audits the bypass", async () => {
    vi.setSystemTime(AFTER_HOURS)
    mocks.userFindUnique.mockResolvedValue(staffRow("SUPER_ADMIN"))

    await expect(signInFrom("198.51.100.1")).resolves.toMatchObject({ id: "u1", role: "SUPER_ADMIN" })
    expect(mocks.auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "STAFF_ACCESS_BYPASSED",
        newValue: expect.objectContaining({ reason: "ip_not_allowed", stage: "sign_in", role: "SUPER_ADMIN" }),
      }),
    })
  })

  it("does not check the policy, or reveal it, before the password is right", async () => {
    vi.setSystemTime(AFTER_HOURS)
    mocks.userFindUnique.mockResolvedValue({ ...staffRow(), active: false })
    await expect(signInFrom("192.0.2.10")).resolves.toBeNull()
    expect(auditActions()).toEqual([])
  })
})

// The SECURITY_* rows the SIEM watches: written on the user's own lender, with the user, only on the staff path.
const securityRows = () => mocks.auditCreate.mock.calls
  .map((c) => (c[0] as { data: Record<string, unknown> }).data)
  .filter((d) => String(d.action).startsWith("SECURITY_"))

describe("security events at sign-in", () => {
  it("records a failed password on the user's lender, once per window", async () => {
    mocks.userFindUnique.mockResolvedValue(staffRow())
    mocks.bcryptCompare.mockResolvedValue(false)
    await expect(signInFrom("192.0.2.10")).resolves.toBeNull()
    await expect(signInFrom("192.0.2.10")).resolves.toBeNull()
    await expect(signInFrom("192.0.2.10")).resolves.toBeNull()
    expect(securityRows()).toEqual([expect.objectContaining({
      action: "SECURITY_LOGIN_FAILED", tenantId: "t1", userId: "u1", userEmail: "officer@example.test", ipAddress: "192.0.2.10",
      newValue: { reason: "wrong_password" },
    })])
  })

  it("records nothing for an email that belongs to no user (no lender to attribute it to)", async () => {
    mocks.userFindUnique.mockResolvedValue(null)
    await expect(signInFrom("192.0.2.10")).rejects.toMatchObject({ code: "wrong_audience" })
    expect(securityRows()).toEqual([])
  })

  it("records a wrong and a replayed TOTP code as TOTP failures, not as sign-ins", async () => {
    mocks.userFindUnique.mockResolvedValue({ ...staffRow(), totpEnabled: true, totpSecret: "sealed" })
    mocks.totpOutcome.mockResolvedValue({ kind: "invalid" })
    await expect(signInFrom("192.0.2.10")).rejects.toMatchObject({ code: expect.any(String) })
    expect(securityRows()).toEqual([expect.objectContaining({ action: "SECURITY_TOTP_FAILED", tenantId: "t1", userId: "u1", newValue: { reason: "totp_invalid" } })])

    resetSecurityEventWindows()
    mocks.auditCreate.mockClear()
    mocks.totpOutcome.mockResolvedValue({ kind: "replayed" })
    await expect(signInFrom("192.0.2.10")).rejects.toMatchObject({ code: expect.any(String) })
    expect(securityRows()).toEqual([expect.objectContaining({ action: "SECURITY_TOTP_FAILED", newValue: { reason: "totp_replay" } })])
  })

  it("records the success after both factors and the access policy passed", async () => {
    mocks.userFindUnique.mockResolvedValue(staffRow())
    await signInFrom("192.0.2.10")
    expect(securityRows()).toEqual([expect.objectContaining({ action: "SECURITY_LOGIN_SUCCEEDED", tenantId: "t1", userId: "u1" })])
  })

  it("records no success for a sign-in the working-hours policy refused", async () => {
    vi.setSystemTime(AFTER_HOURS)
    mocks.userFindUnique.mockResolvedValue(staffRow())
    await expect(signInFrom("192.0.2.10")).rejects.toMatchObject({ code: "access_outside_hours" })
    expect(securityRows()).toEqual([])
  })
})

describe("every session read (jwt callback)", () => {
  const withPolicy = (role = "CREDIT_OFFICER", columns: unknown = policy) => mocks.userFindUnique.mockResolvedValue({
    active: true, role, tenantId: "t1", tokenVersion: 0, tenant: { config: columns },
  })

  it("keeps a session in hours on an allowed network", async () => {
    withPolicy()
    const token = staffToken()
    expect(await jwt({ token })).toEqual(token)
  })

  it("ends a live session when working hours close", async () => {
    withPolicy()
    vi.setSystemTime(AFTER_HOURS)
    expect(await jwt({ token: staffToken() })).toBeNull()
    expect(auditActions()).toEqual(["STAFF_ACCESS_REFUSED"])
  })

  it("ends a live session that moves off the allowlist", async () => {
    withPolicy()
    requestHeaders.value = new Headers({ "x-forwarded-for": "203.0.113.5" })
    expect(await jwt({ token: staffToken() })).toBeNull()
  })

  it("audits a refused session once per window, not on every request", async () => {
    withPolicy()
    vi.setSystemTime(AFTER_HOURS)
    await jwt({ token: staffToken() })
    await jwt({ token: staffToken() })
    await jwt({ token: staffToken() })
    expect(auditActions()).toEqual(["STAFF_ACCESS_REFUSED"])
  })

  it("keeps a Super Admin's session and audits the bypass", async () => {
    withPolicy("SUPER_ADMIN")
    vi.setSystemTime(AFTER_HOURS)
    expect(await jwt({ token: staffToken("SUPER_ADMIN") })).not.toBeNull()
    expect(auditActions()).toEqual(["STAFF_ACCESS_BYPASSED"])
  })

  it("uses the role in the database, not the role in the token", async () => {
    withPolicy("CREDIT_OFFICER")
    vi.setSystemTime(AFTER_HOURS)
    expect(await jwt({ token: staffToken("SUPER_ADMIN") })).toBeNull()
  })

  it("leaves an unrestricted tenant alone and does not read the request", async () => {
    withPolicy("CREDIT_OFFICER", { staffAccessHours: null, staffIpAllowlist: [] })
    vi.setSystemTime(AFTER_HOURS)
    requestHeaders.value = new Headers()
    expect(await jwt({ token: staffToken() })).not.toBeNull()
  })

  it("fails closed on a stored policy it cannot read", async () => {
    withPolicy("ADMIN", { staffAccessHours: { mon: "9 to 5" }, staffIpAllowlist: [] })
    expect(await jwt({ token: staffToken("ADMIN") })).toBeNull()
  })
})
