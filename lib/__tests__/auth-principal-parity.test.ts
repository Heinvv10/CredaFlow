import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Parity between sign-in (authorize) and every request's revalidation (the
// JWT callback): each rule in lib/auth-principal.ts is exercised on BOTH
// paths, for lender staff and operator staff, against the same User row.
const h = vi.hoisted(() => ({
  config: null as null | {
    providers: Array<{ authorize: (c: Record<string, string>, r: Request) => Promise<unknown> }>
    callbacks: { jwt: (a: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null> }
  },
  row: null as null | Record<string, unknown>,
  policy: false,
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
    tenantConfig: { findUnique: async () => ({ requireStaffTotp: h.policy }) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async () => ({}) },
  },
}))
vi.mock("bcryptjs", () => ({ default: { compare: async () => true, hash: async () => "hash", hashSync: () => "hash" } }))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "127.0.0.1" }))

import "@/lib/auth"
import { generateTotpCode, generateTotpSecret } from "@/lib/totp"

const CONSOLE = "console.platform.example"
const LENDER = "app.lender.example"
const SECRET = generateTotpSecret()

const OPERATOR_ROW = {
  id: "op1", email: "op@operator.example", name: "Op", password: "hash", role: "OPERATOR_ADMIN", active: true,
  tenantId: null, operatorId: "operator-1", tokenVersion: 0, totpEnabled: true, totpSecret: SECRET, tenant: null,
}
const STAFF_ROW = {
  id: "u1", email: "admin@lender.example", name: "Admin", password: "hash", role: "ADMIN", active: true,
  tenantId: "t1", operatorId: null, tokenVersion: 0, totpEnabled: true, totpSecret: SECRET, tenant: { status: "ACTIVE" },
}
type Audience = "operator" | "staff"
const base = (a: Audience) => (a === "operator" ? OPERATOR_ROW : STAFF_ROW)

function signIn(audience: Audience, row: Record<string, unknown>, code: string | null = generateTotpCode(SECRET)) {
  h.row = row
  const host = audience === "operator" ? CONSOLE : LENDER
  return h.config!.providers[0].authorize(
    { email: String(row.email), password: "pw", loginType: audience, ...(code ? { code } : {}) },
    new Request(`https://${host}/api/auth/callback/credentials`, { headers: { host } }),
  ).catch((e: { code?: string }) => `threw:${e.code}`)
}
function revalidate(audience: Audience, row: Record<string, unknown>, claims: Record<string, unknown> = {}) {
  h.row = row
  const token = audience === "operator"
    ? { id: "op1", role: "OPERATOR_ADMIN", operatorId: "operator-1", tenantId: null }
    : { id: "u1", role: "ADMIN", tenantId: "t1" }
  return h.config!.callbacks.jwt({ token: { ...token, tokenVersion: 0, totpVerified: true, totpEnrolmentRequired: false, ...claims } })
}

beforeEach(() => {
  vi.stubEnv("OPERATOR_APP_HOST", CONSOLE)
  h.policy = false
})
afterEach(() => vi.unstubAllEnvs())

describe.each(["operator", "staff"] as const)("%s principal — the same row passes or fails both paths", (audience) => {
  it("accepts the valid row on both paths", async () => {
    expect(await signIn(audience, base(audience))).toMatchObject({ id: base(audience).id, totpVerified: true })
    expect(await revalidate(audience, base(audience))).not.toBeNull()
  })

  const refusals: Array<[string, Record<string, unknown>]> = [
    ["inactive", { active: false }],
    ["bound to both a tenant and an operator", { tenantId: "t1", operatorId: "operator-1" }],
    ...(audience === "operator"
      ? [
          ["not an operator role", { role: "ADMIN" }],
          ["not bound to an operator", { operatorId: null }],
          ["bound to a tenant", { tenantId: "t1", operatorId: null, role: "OPERATOR_ADMIN" }],
        ] as Array<[string, Record<string, unknown>]>
      : [
          ["an operator role", { role: "OPERATOR_SUPPORT" }],
          ["bound to an operator", { operatorId: "operator-1" }],
          ["not bound to a tenant", { tenantId: null, tenant: null }],
          ["on a suspended lender", { tenant: { status: "SUSPENDED" } }],
        ] as Array<[string, Record<string, unknown>]>),
  ]
  it.each(refusals)("refuses a row that is %s at sign-in and on the next request", async (_label, change) => {
    const row = { ...base(audience), ...change }
    expect(await signIn(audience, row)).toBeNull()
    expect(await revalidate(audience, row)).toBeNull()
  })

  it("ends a code-verified session once the user has no TOTP (sign-in would hold or refuse it)", async () => {
    const row = { ...base(audience), totpEnabled: false, totpSecret: null }
    expect(await revalidate(audience, row, { totpVerified: true })).toBeNull()
  })

  it("ends a session held at enrolment once the user has enrolled (sign in again with a code)", async () => {
    expect(await revalidate(audience, base(audience), { totpVerified: false, totpEnrolmentRequired: true })).toBeNull()
  })

  it("asks for the code of an enrolled user at sign-in", async () => {
    expect(await signIn(audience, base(audience), null)).toBe("threw:totp_required")
  })
})

describe("enrolment hold — decided the same way on both paths", () => {
  const unenrolled = (a: Audience) => ({ ...base(a), totpEnabled: false, totpSecret: null })

  it("always holds an operator user with no TOTP, whatever any lender's policy", async () => {
    h.policy = false
    expect(await signIn("operator", unenrolled("operator"), null)).toMatchObject({ totpEnrolmentRequired: true })
    expect(await revalidate("operator", unenrolled("operator"), { totpVerified: false, totpEnrolmentRequired: false }))
      .toMatchObject({ totpEnrolmentRequired: true })
  })

  it.each([true, false])("holds lender staff with no TOTP exactly when the lender's policy says so (policy %s)", async (policy) => {
    h.policy = policy
    expect(await signIn("staff", unenrolled("staff"), null)).toMatchObject({ totpEnrolmentRequired: policy })
    expect(await revalidate("staff", unenrolled("staff"), { totpVerified: false, totpEnrolmentRequired: !policy }))
      .toMatchObject({ totpEnrolmentRequired: policy })
  })
})

describe("a token is checked as the audience it was minted for, never re-routed", () => {
  it("refuses an operator-claiming token whose row is lender staff", async () => {
    h.row = STAFF_ROW
    expect(await h.config!.callbacks.jwt({
      token: { id: "u1", role: "OPERATOR_ADMIN", operatorId: "operator-1", tenantId: null, tokenVersion: 0, totpVerified: true, totpEnrolmentRequired: false },
    })).toBeNull()
  })

  it("refuses a lender-staff token whose row is an operator user", async () => {
    h.row = OPERATOR_ROW
    expect(await h.config!.callbacks.jwt({
      token: { id: "op1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpVerified: true, totpEnrolmentRequired: false },
    })).toBeNull()
  })

  it("refuses each audience's sign-in on the other's host", async () => {
    h.row = OPERATOR_ROW
    const onLender = await h.config!.providers[0].authorize(
      { email: "op@operator.example", password: "pw", loginType: "operator", code: generateTotpCode(SECRET) },
      new Request(`https://${LENDER}/x`, { headers: { host: LENDER } }),
    ).catch((e: { code?: string }) => e.code)
    expect(onLender).toBe("wrong_audience")
    h.row = STAFF_ROW
    const onConsole = await h.config!.providers[0].authorize(
      { email: "admin@lender.example", password: "pw", loginType: "staff" },
      new Request(`https://${CONSOLE}/x`, { headers: { host: CONSOLE } }),
    ).catch((e: { code?: string }) => e.code)
    expect(onConsole).toBe("wrong_audience")
  })
})
