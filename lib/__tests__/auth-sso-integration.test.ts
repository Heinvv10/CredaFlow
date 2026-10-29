import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// How single sign-on meets the existing sign-in and per-request rules
// (lib/auth.ts, lib/auth-principal.ts): password sign-in switched off, and the
// provider-MFA claim surviving revalidation only while the lender trusts it.
const h = vi.hoisted(() => ({
  config: null as null | {
    providers: Array<{ id?: string; authorize: (c: Record<string, string>, r: Request) => Promise<unknown> }>
    callbacks: { jwt: (a: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null> }
  },
  row: null as null | Record<string, unknown>,
  policy: true,
  audits: [] as string[],
}))
vi.mock("next-auth", () => ({
  default: (config: typeof h.config) => {
    h.config = config
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }
  },
  CredentialsSignin: class extends Error { code = "credentials" },
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => h.row, updateMany: async () => ({ count: 1 }), update: async () => ({}) },
    tenantConfig: { findUnique: async () => ({ requireStaffTotp: h.policy, staffAccessHours: null, staffIpAllowlist: null }) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async () => ({}) },
    auditLog: { create: async ({ data }: { data: { action: string } }) => { h.audits.push(data.action) } },
  },
}))
vi.mock("bcryptjs", () => ({ default: { compare: async () => true, hash: async () => "hash", hashSync: () => "hash" } }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "203.0.113.10", callerIpFromHeaders: () => "203.0.113.10" }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))

import "@/lib/auth"
import { generateTotpCode, generateTotpSecret } from "@/lib/totp"

const SECRET = generateTotpSecret()
const sso = (over: Record<string, unknown> = {}) => ({ enabled: true, passwordLoginDisabled: true, ...over })
const row = (over: Record<string, unknown> = {}, ssoConnection: Record<string, unknown> | null = sso()) => ({
  id: "u1", email: "admin@lender.example", name: "Admin", password: "hash", role: "ADMIN", active: true,
  tenantId: "t1", operatorId: null, tokenVersion: 0, totpEnabled: true, totpSecret: SECRET,
  tenant: { status: "ACTIVE", ssoConnection }, ...over,
})

function signIn(r: Record<string, unknown>, code: string | null = generateTotpCode(SECRET)) {
  h.row = r
  return h.config!.providers[0].authorize(
    { email: String(r.email), password: "pw", loginType: "staff", ...(code ? { code } : {}) },
    new Request("https://app.lender.example/api/auth/callback/credentials", { headers: { host: "app.lender.example" } }),
  ).catch((e: { code?: string }) => `threw:${e.code}`)
}

beforeEach(() => { h.policy = true; h.audits.length = 0 })
afterEach(() => vi.unstubAllEnvs())

describe("password sign-in turned off by the lender", () => {
  it("refuses an admin even with the right password and a valid code", async () => {
    expect(await signIn(row())).toBe("threw:password_login_disabled")
  })

  it("refuses an admin before asking for a code", async () => {
    expect(await signIn(row(), null)).toBe("threw:password_login_disabled")
  })

  it("lets a Super Admin in with password and a valid code (break-glass), and audits it", async () => {
    expect(await signIn(row({ role: "SUPER_ADMIN" }))).toMatchObject({ id: "u1", role: "SUPER_ADMIN", totpVerified: true })
    expect(h.audits).toContain("SSO_PASSWORD_BREAK_GLASS")
  })

  it("asks a Super Admin for the code first", async () => {
    expect(await signIn(row({ role: "SUPER_ADMIN" }), null)).toBe("threw:totp_required")
  })

  it("refuses a Super Admin with no TOTP enrolled: the password alone never opens it", async () => {
    expect(await signIn(row({ role: "SUPER_ADMIN", totpEnabled: false, totpSecret: null }), null)).toBe("threw:password_login_disabled")
    expect(h.audits).not.toContain("SSO_PASSWORD_BREAK_GLASS")
  })

  it("refuses a Super Admin whose code is wrong", async () => {
    expect(await signIn(row({ role: "SUPER_ADMIN" }), "000000")).toBe("threw:totp_invalid")
  })

  it.each([
    ["SSO is switched off", sso({ enabled: false })],
    ["password sign-in was never turned off", sso({ passwordLoginDisabled: false })],
    ["the lender has no connection", null],
  ])("changes nothing when %s", async (_l, connection) => {
    expect(await signIn(row({}, connection))).toMatchObject({ id: "u1", totpVerified: true })
    expect(h.audits).not.toContain("SSO_PASSWORD_BREAK_GLASS")
  })
})

describe("SSO sessions in the JWT callback", () => {
  const jwt = (token: Record<string, unknown>) => {
    h.row = row({ totpEnabled: true })
    return h.config!.callbacks.jwt({ token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: false, totpEnrolmentRequired: false, ...token } })
  }
  const now = () => Math.floor(Date.now() / 1000)

  it("carries the absolute expiry from sign-in into the token", async () => {
    const token = await h.config!.callbacks.jwt({
      token: {}, user: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: false, totpEnrolmentRequired: false, ssoSessionExp: now() + 3600 },
    })
    expect(token).toMatchObject({ ssoExp: expect.any(Number) })
  })

  it("ends the session once the SSO lifetime has passed, so the user signs in at the provider again", async () => {
    expect(await jwt({ ssoExp: now() - 1 })).toBeNull()
  })

  it("keeps a session inside its lifetime", async () => {
    expect(await jwt({ ssoExp: now() + 3600 })).not.toBeNull()
  })

  it("does not touch password sessions (no expiry claim)", async () => {
    expect(await jwt({})).not.toBeNull()
  })

  it("does not trust provider MFA: an unenrolled user stays held at enrolment on every request", async () => {
    h.row = row({ totpEnabled: false, totpSecret: null })
    const token = await h.config!.callbacks.jwt({ token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: false, totpEnrolmentRequired: true, idpMfa: true } })
    expect(token).toMatchObject({ totpEnrolmentRequired: true })
  })
})
