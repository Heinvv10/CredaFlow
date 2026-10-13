import { beforeEach, describe, expect, it, vi } from "vitest"

// The totpVerified claim is what PUT /api/settings/identity trusts as "this
// session passed 2FA". These tests drive the real authorize() and jwt/session
// callbacks from lib/auth.ts; only NextAuth itself, the DB and bcrypt are
// stubbed. NextAuth(config) is captured so the callbacks can be called.
const h = vi.hoisted(() => ({
  config: null as null | {
    providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>
    callbacks: {
      jwt: (args: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>
      session: (args: { session: { user: Record<string, unknown> }; token: Record<string, unknown> }) => Promise<{ user: Record<string, unknown> }>
    }
  },
  findUser: vi.fn(),
  updateManyUser: vi.fn(),
  findConfig: vi.fn(),
}))

vi.mock("next-auth", () => ({
  default: (config: typeof h.config) => {
    h.config = config
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }
  },
  CredentialsSignin: class extends Error {},
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: (a: unknown) => h.findUser(a),
      updateMany: (a: unknown) => h.updateManyUser(a),
      update: async () => ({}),
    },
    tenantConfig: { findUnique: (a: unknown) => h.findConfig(a) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async () => ({}) },
  },
}))
vi.mock("bcryptjs", () => ({ default: { compare: async () => true, hash: async () => "hash", hashSync: () => "hash" } }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "127.0.0.1" }))

import "@/lib/auth"
import { generateTotpCode, generateTotpSecret } from "@/lib/totp"

const request = new Request("https://app.lender.example/api/auth/callback/credentials", {
  headers: { "user-agent": "vitest" },
})
const staff = (extra: Record<string, unknown>) => ({
  id: "u1", email: "admin@lender.example", name: "Admin", password: "hash", role: "ADMIN",
  active: true, tenantId: "t1", tokenVersion: 0, totpEnabled: false, totpSecret: null, ...extra,
})
const authorize = (credentials: Record<string, string>) =>
  h.config!.providers[0].authorize({ email: "admin@lender.example", password: "pw", loginType: "staff", ...credentials }, request)

beforeEach(() => {
  h.findUser.mockReset()
  h.updateManyUser.mockReset().mockResolvedValue({ count: 1 })
  h.findConfig.mockReset().mockResolvedValue({ requireStaffTotp: false })
})

describe("totpVerified claim — authorize()", () => {
  it("is false for a password-only sign-in (no TOTP enrolled)", async () => {
    h.findUser.mockResolvedValue(staff({}))
    await expect(authorize({})).resolves.toMatchObject({ id: "u1", totpVerified: false })
  })

  it("is true only after a valid TOTP code is checked", async () => {
    const secret = generateTotpSecret()
    h.findUser.mockResolvedValue(staff({ totpEnabled: true, totpSecret: secret }))
    await expect(authorize({ code: generateTotpCode(secret) })).resolves.toMatchObject({ totpVerified: true })
  })

  it("never mints a session for an enrolled account without a valid code", async () => {
    const secret = generateTotpSecret()
    h.findUser.mockResolvedValue(staff({ totpEnabled: true, totpSecret: secret }))
    await expect(authorize({})).rejects.toBeInstanceOf(Error)
    const wrong = String((Number(generateTotpCode(secret)) + 1) % 1_000_000).padStart(6, "0")
    await expect(authorize({ code: wrong })).rejects.toBeInstanceOf(Error)
  })
})

// The per-lender policy (TenantConfig.requireStaffTotp, default on): a staff
// user with no TOTP enrolled signs in, carrying a claim that proxy.ts and the
// auth guards turn into "enrolment page only".
describe("totpEnrolmentRequired claim — authorize()", () => {
  it("is set for an unenrolled user while the tenant requires 2FA", async () => {
    h.findConfig.mockResolvedValue({ requireStaffTotp: true })
    h.findUser.mockResolvedValue(staff({}))
    await expect(authorize({})).resolves.toMatchObject({ id: "u1", totpVerified: false, totpEnrolmentRequired: true })
    expect(h.findConfig).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1" } }))
  })

  it("treats a tenant with no config row as requiring 2FA", async () => {
    h.findConfig.mockResolvedValue(null)
    h.findUser.mockResolvedValue(staff({}))
    await expect(authorize({})).resolves.toMatchObject({ totpEnrolmentRequired: true })
  })

  it("is not set while the tenant does not require 2FA: no code is demanded of an unenrolled user", async () => {
    h.findUser.mockResolvedValue(staff({}))
    await expect(authorize({})).resolves.toMatchObject({ totpVerified: false, totpEnrolmentRequired: false })
  })

  it("is not set for an enrolled user who presents a valid code", async () => {
    h.findConfig.mockResolvedValue({ requireStaffTotp: true })
    const secret = generateTotpSecret()
    h.findUser.mockResolvedValue(staff({ totpEnabled: true, totpSecret: secret }))
    await expect(authorize({ code: generateTotpCode(secret) })).resolves.toMatchObject({ totpVerified: true, totpEnrolmentRequired: false })
  })

  it("an enrolled user is still refused without a code, whatever the policy", async () => {
    h.findUser.mockResolvedValue(staff({ totpEnabled: true, totpSecret: generateTotpSecret() }))
    await expect(authorize({})).rejects.toBeInstanceOf(Error)
  })

  it("fails the sign-in rather than skipping the policy when it cannot be read", async () => {
    h.findConfig.mockRejectedValue(new Error("db down"))
    h.findUser.mockResolvedValue(staff({}))
    await expect(authorize({})).rejects.toThrow("db down")
  })
})

describe("totpEnrolmentRequired claim — jwt/session callbacks", () => {
  it("copies the claim into the token on sign-in, true only when true", async () => {
    const forced = await h.config!.callbacks.jwt({ token: {}, user: { id: "u1", role: "ADMIN", tenantId: "t1", totpEnrolmentRequired: true } })
    expect(forced?.totpEnrolmentRequired).toBe(true)
    const free = await h.config!.callbacks.jwt({ token: {}, user: { id: "u1", role: "ADMIN", tenantId: "t1" } })
    expect(free?.totpEnrolmentRequired).toBe(false)
  })

  it("keeps the claim across a token refresh", async () => {
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0 })
    const kept = await h.config!.callbacks.jwt({
      token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpEnrolmentRequired: true },
    })
    expect(kept?.totpEnrolmentRequired).toBe(true)
  })

  it("puts it on the session only when the token says true", async () => {
    for (const value of [undefined, false, "true", 1]) {
      const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1", totpEnrolmentRequired: value } })
      expect(session.user.totpEnrolmentRequired).toBe(false)
    }
    const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1", totpEnrolmentRequired: true } })
    expect(session.user.totpEnrolmentRequired).toBe(true)
  })
})

describe("totpVerified claim — jwt/session callbacks", () => {
  it("copies the claim into the token only on sign-in, and only when true", async () => {
    const signedIn = await h.config!.callbacks.jwt({ token: {}, user: { id: "u1", role: "ADMIN", tenantId: "t1", totpVerified: true } })
    expect(signedIn?.totpVerified).toBe(true)
    const passwordOnly = await h.config!.callbacks.jwt({ token: {}, user: { id: "u1", role: "ADMIN", tenantId: "t1" } })
    expect(passwordOnly?.totpVerified).toBe(false)
  })

  // A refresh (no `user`) revalidates the principal against the DB; it must
  // keep the claim exactly as minted and never grant it.
  it("keeps a password-only session's claim false across token refreshes", async () => {
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0 })
    const refreshed = await h.config!.callbacks.jwt({
      token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: false },
    })
    expect(h.findUser).toHaveBeenCalled()
    expect(refreshed?.totpVerified).toBe(false)
    const kept = await h.config!.callbacks.jwt({
      token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: true },
    })
    expect(kept?.totpVerified).toBe(true)
  })

  it("maps an absent or non-true claim to false on the session (tokens issued before the claim existed)", async () => {
    for (const totpVerified of [undefined, false, "true", 1]) {
      const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1", totpVerified } })
      expect(session.user.totpVerified).toBe(false)
    }
    const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1", totpVerified: true } })
    expect(session.user.totpVerified).toBe(true)
  })
})

// Staff-user writes compare it with the caller's locked row
// (refuseLockedStaffUserWrite), so a session invalidated mid-request — a role
// change, deactivation or password reset bumps the version — cannot finish one.
describe("tokenVersion — session callback", () => {
  it("copies the token's version onto the session", async () => {
    const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 4 } })
    expect(session.user.tokenVersion).toBe(4)
  })

  it("leaves it unset when the token carries no number, so the write gate fails closed", async () => {
    for (const tokenVersion of [undefined, "4", null]) {
      const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion } })
      expect(session.user.tokenVersion).toBeUndefined()
    }
  })
})
