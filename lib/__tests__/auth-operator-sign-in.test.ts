import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Drives the real authorize() and jwt/session callbacks of lib/auth.ts for
// operator staff, lender staff on a suspended lender, and the host rule (the
// operator console host takes operator sign-ins only, and only it does).
// NextAuth, the DB and bcrypt are stubbed.
const h = vi.hoisted(() => ({
  config: null as null | {
    providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>
    callbacks: {
      jwt: (args: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>
      session: (args: { session: { user: Record<string, unknown> }; token: Record<string, unknown> }) => Promise<{ user: Record<string, unknown> }>
    }
  },
  findUser: vi.fn(),
  failures: [] as string[],
  passwordOk: true,
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
    user: {
      findUnique: (a: unknown) => h.findUser(a),
      updateMany: async () => ({ count: 1 }),
      update: async () => ({}),
    },
    tenantConfig: { findUnique: async () => ({ requireStaffTotp: false }) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async (a: { data: { reason: string } }) => { h.failures.push(a.data.reason); return {} } },
  },
}))
vi.mock("bcryptjs", () => ({ default: { compare: async () => h.passwordOk, hash: async () => "hash", hashSync: () => "hash" } }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "127.0.0.1" }))

import "@/lib/auth"
import { generateTotpCode, generateTotpSecret } from "@/lib/totp"

const CONSOLE = "console.platform.example"
const LENDER = "app.lender.example"
const SECRET = generateTotpSecret()

const operatorRow = (extra: Record<string, unknown> = {}) => ({
  id: "op1", email: "support@operator.example", name: "Support", password: "hash", role: "OPERATOR_SUPPORT",
  active: true, tenantId: null, operatorId: "operator-1", tokenVersion: 3, totpEnabled: true, totpSecret: SECRET, ...extra,
})
const staffRow = (extra: Record<string, unknown> = {}) => ({
  id: "u1", email: "admin@lender.example", name: "Admin", password: "hash", role: "ADMIN", active: true,
  tenantId: "t1", operatorId: null, tokenVersion: 0, totpEnabled: false, totpSecret: null, tenant: { status: "ACTIVE" }, ...extra,
})

function authorize(host: string, credentials: Record<string, string>) {
  const request = new Request(`https://${host}/api/auth/callback/credentials`, { headers: { host, "user-agent": "vitest" } })
  return h.config!.providers[0].authorize({ email: "x@example.com", password: "pw", ...credentials }, request)
}
const rejection = async (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? "error")

beforeEach(() => {
  vi.stubEnv("OPERATOR_APP_HOST", CONSOLE)
  h.findUser.mockReset()
  h.failures = []
  h.passwordOk = true
})
afterEach(() => vi.unstubAllEnvs())

describe("operator sign-in — authorize()", () => {
  it("signs in an active operator user with a valid TOTP code, bound to the operator and no tenant", async () => {
    h.findUser.mockResolvedValue(operatorRow())
    await expect(authorize(CONSOLE, { loginType: "operator", code: generateTotpCode(SECRET) })).resolves.toMatchObject({
      id: "op1", role: "OPERATOR_SUPPORT", operatorId: "operator-1", tenantId: null, totpVerified: true, totpEnrolmentRequired: false,
    })
  })

  it("requires the code: an enrolled operator without one is asked for it, a wrong one is refused", async () => {
    h.findUser.mockResolvedValue(operatorRow())
    expect(await rejection(authorize(CONSOLE, { loginType: "operator" }))).toBe("totp_required")
    const wrong = String((Number(generateTotpCode(SECRET)) + 500_000) % 1_000_000).padStart(6, "0")
    expect(await rejection(authorize(CONSOLE, { loginType: "operator", code: wrong }))).toBe("totp_invalid")
  })

  it("holds an operator with no TOTP at enrolment whatever any lender's policy says", async () => {
    h.findUser.mockResolvedValue(operatorRow({ totpEnabled: false, totpSecret: null }))
    await expect(authorize(CONSOLE, { loginType: "operator" })).resolves.toMatchObject({ totpVerified: false, totpEnrolmentRequired: true })
  })

  it("refuses an inactive operator user, before any code is asked for", async () => {
    h.findUser.mockResolvedValue(operatorRow({ active: false }))
    await expect(authorize(CONSOLE, { loginType: "operator" })).resolves.toBeNull()
    expect(h.failures).toContain("operator_inactive")
  })

  it("refuses a lender's staff member on the operator form", async () => {
    h.findUser.mockResolvedValue(staffRow({ role: "SUPER_ADMIN" }))
    await expect(authorize(CONSOLE, { loginType: "operator" })).resolves.toBeNull()
    expect(h.failures).toContain("not_operator")
  })

  it("refuses a wrong password", async () => {
    h.passwordOk = false
    h.findUser.mockResolvedValue(operatorRow())
    await expect(authorize(CONSOLE, { loginType: "operator", code: generateTotpCode(SECRET) })).resolves.toBeNull()
  })
})

describe("the host decides the audience", () => {
  it("refuses an operator sign-in off the operator host", async () => {
    h.findUser.mockResolvedValue(operatorRow())
    expect(await rejection(authorize(LENDER, { loginType: "operator", code: generateTotpCode(SECRET) }))).toBe("wrong_audience")
    expect(h.findUser).not.toHaveBeenCalled()
  })

  it("refuses an operator sign-in anywhere while OPERATOR_APP_HOST is unset", async () => {
    vi.stubEnv("OPERATOR_APP_HOST", "")
    expect(await rejection(authorize(CONSOLE, { loginType: "operator" }))).toBe("wrong_audience")
  })

  it("refuses a staff or portal sign-in on the operator host", async () => {
    h.findUser.mockResolvedValue(staffRow())
    expect(await rejection(authorize(CONSOLE, { loginType: "staff" }))).toBe("wrong_audience")
    expect(await rejection(authorize(CONSOLE, { loginType: "client" }))).toBe("wrong_audience")
  })

  it("refuses an operator user on the staff form (no tenant)", async () => {
    h.findUser.mockResolvedValue(operatorRow())
    await expect(authorize(LENDER, { loginType: "staff", code: generateTotpCode(SECRET) })).resolves.toBeNull()
  })
})

describe("suspended lender — staff sign-in and sessions", () => {
  it("refuses a suspended lender's staff at sign-in", async () => {
    h.findUser.mockResolvedValue(staffRow({ tenant: { status: "SUSPENDED" } }))
    await expect(authorize(LENDER, { loginType: "staff" })).resolves.toBeNull()
    expect(h.failures).toEqual(["tenant_suspended"])
  })

  it("still signs in an active lender's staff", async () => {
    h.findUser.mockResolvedValue(staffRow())
    await expect(authorize(LENDER, { loginType: "staff" })).resolves.toMatchObject({ id: "u1", tenantId: "t1" })
  })

  it("ends an open staff session once the lender is suspended", async () => {
    const token = { id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpEnrolmentRequired: false }
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0, tenant: { status: "ACTIVE" } })
    expect(await h.config!.callbacks.jwt({ token: { ...token } })).not.toBeNull()
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", tokenVersion: 0, tenant: { status: "SUSPENDED" } })
    expect(await h.config!.callbacks.jwt({ token: { ...token } })).toBeNull()
  })
})

describe("operator sessions — jwt/session callbacks", () => {
  const fresh = (extra: Record<string, unknown> = {}) => ({
    active: true, role: "OPERATOR_SUPPORT", operatorId: "operator-1", tenantId: null, tokenVersion: 3, totpEnabled: true, totpSecret: SECRET, ...extra,
  })
  const token = () => ({ id: "op1", role: "OPERATOR_SUPPORT", operatorId: "operator-1", tenantId: null, tokenVersion: 3, totpVerified: true, totpEnrolmentRequired: false })

  it("mints a token with the operator and no tenant; refuses one without an operator", async () => {
    const signedIn = await h.config!.callbacks.jwt({ token: {}, user: { id: "op1", role: "OPERATOR_ADMIN", tenantId: null, operatorId: "operator-1", totpVerified: true } })
    expect(signedIn).toMatchObject({ role: "OPERATOR_ADMIN", operatorId: "operator-1", tenantId: null })
    expect(await h.config!.callbacks.jwt({ token: {}, user: { id: "op1", role: "OPERATOR_ADMIN", tenantId: null } })).toBeNull()
  })

  it("re-reads the operator user on every request and carries the database's role", async () => {
    h.findUser.mockResolvedValue(fresh({ role: "OPERATOR_ADMIN" }))
    expect(await h.config!.callbacks.jwt({ token: token() })).toMatchObject({ role: "OPERATOR_ADMIN", operatorId: "operator-1" })
  })

  it.each([
    ["deactivated", { active: false }],
    ["moved to a lender role", { role: "ADMIN", operatorId: null, tenantId: "t1" }],
    ["unbound from its operator", { operatorId: null }],
    ["password reset (tokenVersion bumped)", { tokenVersion: 4 }],
  ])("signs out an operator session once the user is %s", async (_label, change) => {
    h.findUser.mockResolvedValue(fresh(change))
    expect(await h.config!.callbacks.jwt({ token: token() })).toBeNull()
  })

  it("puts the operator on the session", async () => {
    const session = await h.config!.callbacks.session({ session: { user: {} }, token: token() })
    expect(session.user).toMatchObject({ operatorId: "operator-1", tenantId: null, role: "OPERATOR_SUPPORT", totpVerified: true })
  })
})
