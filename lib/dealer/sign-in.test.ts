import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Drives the real authorize() of lib/auth.ts for loginType "dealer": the host
// rule (only DEALER_APP_HOST takes a dealer sign-in, and it takes nothing
// else), the lookup by the host's lender and email, and the refusal set.
// NextAuth, the DB, the tenant lookup and bcrypt are stubbed.
const h = vi.hoisted(() => ({
  config: null as null | {
    providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>
  },
  findDealerUser: vi.fn(),
  updateDealerUser: vi.fn(async (_args: unknown) => ({})),
  findUser: vi.fn(async (_args: unknown) => null),
  tenant: { id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" } as Record<string, unknown> | null,
  failures: [] as string[],
  audits: [] as Array<Record<string, unknown>>,
  compares: 0,
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
    user: { findUnique: (a: unknown) => h.findUser(a), update: async () => ({}) },
    dealerUser: { findUnique: (a: unknown) => h.findDealerUser(a), update: (a: unknown) => h.updateDealerUser(a) },
    loginLog: { create: async () => ({}) },
    failedLoginAttempt: { create: async (a: { data: { reason: string } }) => { h.failures.push(a.data.reason); return {} } },
  },
}))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => h.tenant }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: async (a: Record<string, unknown>) => { h.audits.push(a) },
}))
vi.mock("bcryptjs", () => ({
  default: { compare: async () => { h.compares++; return h.passwordOk }, hash: async () => "hash", hashSync: () => "hash" },
}))
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: () => ({ allowed: true }), callerIp: () => "127.0.0.1" }))

import "@/lib/auth"

const DEALER_HOST = "dealers.lender.example"
const STAFF_HOST = "app.lender.example"
const CONSOLE = "console.platform.example"

const dealerUser = (extra: Record<string, unknown> = {}, dealer: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
  id: "du-1", tenantId: "tenant-1", dealerId: "dealer-1", email: "sales@dealer.example", name: "TEST Sales", role: "DEALER_SALES",
  active: true, passwordHash: "hash", tokenVersion: 2,
  dealer: {
    active: true,
    tenant: { status: "ACTIVE", config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true, ...config } },
    ...dealer,
  },
  ...extra,
})

function authorize(host: string, credentials: Record<string, string>) {
  const request = new Request(`https://${host}/api/auth/callback/credentials`, { headers: { host, "user-agent": "vitest" } })
  return h.config!.providers[0].authorize({ email: "Sales@Dealer.example", password: "pw", ...credentials }, request)
}
const rejection = async (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string }) => e.code ?? "error")

beforeEach(() => {
  vi.stubEnv("DEALER_APP_HOST", DEALER_HOST)
  vi.stubEnv("OPERATOR_APP_HOST", CONSOLE)
  vi.stubEnv("APP_MODE", "")
  h.findDealerUser.mockReset()
  h.updateDealerUser.mockClear()
  h.findUser.mockClear()
  h.tenant = { id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" }
  h.failures = []
  h.audits = []
  h.compares = 0
  h.passwordOk = true
})
afterEach(() => vi.unstubAllEnvs())

describe("dealer sign-in — authorize()", () => {
  it("signs in an active dealer user of the host's lender, with the dealer claims", async () => {
    h.findDealerUser.mockResolvedValue(dealerUser())
    await expect(authorize(DEALER_HOST, { loginType: "dealer" })).resolves.toEqual({
      id: "du-1", email: "sales@dealer.example", name: "TEST Sales", role: "DEALER", tenantId: "tenant-1",
      dealerId: "dealer-1", dealerRole: "DEALER_SALES", tokenVersion: 2, totpVerified: false, totpEnrolmentRequired: false,
    })
    expect(h.findDealerUser).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId_email: { tenantId: "tenant-1", email: "sales@dealer.example" } },
    }))
    expect(h.findUser).not.toHaveBeenCalled()
    expect(h.updateDealerUser).toHaveBeenCalledWith({ where: { id: "du-1" }, data: { lastLoginAt: expect.any(Date) } })
    expect(h.audits).toEqual([expect.objectContaining({
      action: "DEALER_SIGNED_IN", tenantId: "tenant-1", userId: undefined, userEmail: "sales@dealer.example", entityId: "du-1",
      newValue: { actor: { type: "dealer", dealerId: "dealer-1", dealerUserId: "du-1" } },
    })])
  })

  it("refuses a wrong password, and an unknown email after the same bcrypt work", async () => {
    h.passwordOk = false
    h.findDealerUser.mockResolvedValue(dealerUser())
    await expect(authorize(DEALER_HOST, { loginType: "dealer" })).resolves.toBeNull()
    h.findDealerUser.mockResolvedValue(null)
    await expect(authorize(DEALER_HOST, { loginType: "dealer" })).resolves.toBeNull()
    expect(h.failures).toEqual(["dealer_wrong_password", "dealer_wrong_password"])
    expect(h.compares).toBe(2)
    expect(h.audits).toEqual([])
  })

  it.each([
    ["an inactive user", dealerUser({ active: false }), "dealer_inactive"],
    ["a user with no password yet", dealerUser({ passwordHash: null }), "dealer_inactive"],
    ["an inactive dealer", dealerUser({}, { active: false }), "dealer_inactive"],
    ["a suspended lender", dealerUser({}, { tenant: { status: "SUSPENDED", config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true } } }), "dealer_inactive"],
    ["the portal off", dealerUser({}, {}, { featureDealerPortal: false }), "dealer_portal_off"],
    ["asset finance off", dealerUser({}, {}, { featureAssetFinance: false }), "dealer_portal_off"],
    ["a lender that is not a demo lender", dealerUser({}, {}, { isDemoLender: false }), "dealer_portal_off"],
  ])("refuses %s, after bcrypt", async (_label, row, reason) => {
    h.findDealerUser.mockResolvedValue(row)
    await expect(authorize(DEALER_HOST, { loginType: "dealer" })).resolves.toBeNull()
    expect(h.failures).toEqual([reason])
    expect(h.compares).toBe(1)
    expect(h.updateDealerUser).not.toHaveBeenCalled()
  })

  it("refuses when the host resolves no lender, without a lookup", async () => {
    h.tenant = null
    await expect(authorize(DEALER_HOST, { loginType: "dealer" })).resolves.toBeNull()
    expect(h.findDealerUser).not.toHaveBeenCalled()
    expect(h.compares).toBe(1)
  })
})

describe("the host decides the audience", () => {
  it("refuses a dealer sign-in off the dealer host, before any lookup", async () => {
    h.findDealerUser.mockResolvedValue(dealerUser())
    for (const host of [STAFF_HOST, CONSOLE]) {
      expect(await rejection(authorize(host, { loginType: "dealer" }))).toBe("wrong_audience")
    }
    expect(h.findDealerUser).not.toHaveBeenCalled()
  })

  it("refuses a dealer sign-in anywhere while DEALER_APP_HOST is unset", async () => {
    vi.stubEnv("DEALER_APP_HOST", "")
    expect(await rejection(authorize(DEALER_HOST, { loginType: "dealer" }))).toBe("wrong_audience")
  })

  it("refuses a staff, client or operator sign-in on the dealer host", async () => {
    for (const loginType of ["staff", "client", "operator", ""]) {
      expect(await rejection(authorize(DEALER_HOST, { loginType })), loginType).toBe("wrong_audience")
    }
    expect(h.findUser).not.toHaveBeenCalled()
    expect(h.findDealerUser).not.toHaveBeenCalled()
  })

  it("refuses a dealer sign-in on a client-audience container", async () => {
    vi.stubEnv("APP_MODE", "client")
    expect(await rejection(authorize(DEALER_HOST, { loginType: "dealer" }))).toBe("wrong_audience")
  })
})
