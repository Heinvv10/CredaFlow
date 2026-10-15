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
  findClient: vi.fn(),
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
    client: { findFirst: (a: unknown) => h.findClient(a) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async () => ({}) },
  },
}))
vi.mock("bcryptjs", () => ({ default: { compare: async () => true, hash: async () => "hash", hashSync: () => "hash" } }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "127.0.0.1" }))

import "@/lib/auth"
import { clientCredentialStamp } from "@/lib/client-session"
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

  // Enrolment and replacement store the counter of the code that proved the
  // secret as lastTotpCounter, so signing in with that same code is a replay.
  it("refuses a code whose counter was already claimed (the enrolment code, replayed at sign-in)", async () => {
    const secret = generateTotpSecret()
    h.findUser.mockResolvedValue(staff({ totpEnabled: true, totpSecret: secret }))
    h.updateManyUser.mockResolvedValue({ count: 0 })
    await expect(authorize({ code: generateTotpCode(secret) })).rejects.toBeInstanceOf(Error)
    expect(h.updateManyUser).toHaveBeenCalledWith(expect.objectContaining({ data: { lastTotpCounter: Math.floor(Date.now() / 30000) } }))
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

  it("keeps the claim across a token refresh while the lender still requires 2FA", async () => {
    // Revalidation re-decides the hold as sign-in would (lib/auth-principal.ts).
    h.findConfig.mockResolvedValue({ requireStaffTotp: true })
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0 })
    const kept = await h.config!.callbacks.jwt({
      token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpEnrolmentRequired: true },
    })
    expect(kept?.totpEnrolmentRequired).toBe(true)
  })

  // A staff token minted before the claim existed says nothing about whether
  // the user is held at enrolment. Reading that as "not held" would leave every
  // such session free of the policy until it expires, so it is signed out.
  it("signs out a staff token that carries no claim, and does not even consult the database", async () => {
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0 })
    for (const totpEnrolmentRequired of [undefined, "false", 0, null]) {
      const refreshed = await h.config!.callbacks.jwt({
        token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: true, totpEnrolmentRequired },
      })
      expect(refreshed, String(totpEnrolmentRequired)).toBeNull()
    }
    expect(h.findUser).not.toHaveBeenCalled()
  })

  it("leaves a CLIENT token alone (it has no enrolment claim; its own credential stamp is what counts)", async () => {
    vi.stubEnv("AUTH_SECRET", "totp-claim-test-secret")
    h.findClient.mockResolvedValue({ portalPassword: "hash" })
    const kept = await h.config!.callbacks.jwt({
      token: { id: "c1", role: "CLIENT", tenantId: "t1", credentialStamp: clientCredentialStamp("c1", "t1", "hash") },
    })
    vi.unstubAllEnvs()
    expect(kept).toMatchObject({ id: "c1", role: "CLIENT" })
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
      token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: false, totpEnrolmentRequired: false },
    })
    expect(h.findUser).toHaveBeenCalled()
    expect(refreshed?.totpVerified).toBe(false)
    // A code-verified session holds only while the user still has TOTP.
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpEnabled: true, totpSecret: "S" })
    const kept = await h.config!.callbacks.jwt({
      token: { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: true, totpEnrolmentRequired: false },
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
