import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The jwt and session callbacks of lib/auth.ts for a DEALER token: claims at
// sign-in, revalidation against DealerUser on every request (before, and
// never through, the staff branch), and the refusal set. The reverse: a staff
// token is never revalidated as a dealer's. NextAuth and the DB are stubbed.
const h = vi.hoisted(() => ({
  config: null as null | {
    callbacks: {
      jwt: (args: { token: Record<string, unknown>; user?: Record<string, unknown> }) => Promise<Record<string, unknown> | null>
      session: (args: { session: { user: Record<string, unknown> }; token: Record<string, unknown> }) => Promise<{ user: Record<string, unknown> }>
    }
  },
  findDealerUser: vi.fn(),
  findUser: vi.fn(),
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
    user: { findUnique: (a: unknown) => h.findUser(a) },
    dealerUser: { findUnique: (a: unknown) => h.findDealerUser(a) },
    tenantConfig: { findUnique: async () => ({ requireStaffTotp: false }) },
  },
}))
vi.mock("@/lib/security/staff-access-enforcement", () => ({ checkStaffSignIn: vi.fn(), staffSessionAllowed: async () => true }))

import "@/lib/auth"

const jwt = (token: Record<string, unknown>, user?: Record<string, unknown>) => h.config!.callbacks.jwt({ token, user })

const signInUser = {
  id: "du-1", email: "sales@dealer.example", name: "TEST Sales", role: "DEALER", tenantId: "tenant-1",
  dealerId: "dealer-1", dealerRole: "DEALER_SALES", tokenVersion: 2, totpVerified: false, totpEnrolmentRequired: false,
}
const dealerToken = (extra: Record<string, unknown> = {}) => ({
  id: "du-1", email: "sales@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES",
  tokenVersion: 2, totpVerified: false, totpEnrolmentRequired: false, ...extra,
})
const row = (extra: Record<string, unknown> = {}, dealer: Record<string, unknown> = {}, config: Record<string, unknown> = {}) => ({
  id: "du-1", tenantId: "tenant-1", dealerId: "dealer-1", email: "sales@dealer.example", name: "TEST Sales", role: "DEALER_SALES",
  active: true, passwordHash: "hash", tokenVersion: 2,
  dealer: {
    active: true,
    tenant: { status: "ACTIVE", config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true, ...config } },
    ...dealer,
  },
  ...extra,
})

beforeEach(() => {
  vi.stubEnv("APP_MODE", "")
  h.findDealerUser.mockReset()
  h.findUser.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe("DEALER token — sign-in claims", () => {
  it("carries the tenant, dealer and dealer role into the token and the session", async () => {
    const token = await jwt({}, signInUser)
    expect(token).toMatchObject({ id: "du-1", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES", tokenVersion: 2 })
    const session = await h.config!.callbacks.session({ session: { user: {} }, token: token! })
    expect(session.user).toMatchObject({ id: "du-1", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_SALES" })
  })

  it("refuses a dealer sign-in without a tenant or a dealer", async () => {
    expect(await jwt({}, { ...signInUser, tenantId: null })).toBeNull()
    expect(await jwt({}, { ...signInUser, dealerId: undefined })).toBeNull()
  })

  it("gives a staff session no dealer claims", async () => {
    const session = await h.config!.callbacks.session({ session: { user: {} }, token: { id: "u1", role: "ADMIN", tenantId: "t1" } })
    expect(session.user).toMatchObject({ dealerId: null, dealerRole: null })
  })
})

describe("DEALER token — every request", () => {
  it("revalidates against DealerUser, never the User table, and picks up a role change", async () => {
    h.findDealerUser.mockResolvedValue(row({ role: "DEALER_ADMIN" }))
    await expect(jwt(dealerToken())).resolves.toMatchObject({ role: "DEALER", dealerRole: "DEALER_ADMIN" })
    expect(h.findDealerUser).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "du-1" } }))
    expect(h.findUser).not.toHaveBeenCalled()
  })

  it.each([
    ["the user deactivated", row({ active: false })],
    ["the tokenVersion bumped", row({ tokenVersion: 3 })],
    ["the dealer deactivated", row({}, { active: false })],
    ["the lender suspended", row({}, { tenant: { status: "SUSPENDED", config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true } } })],
    ["the portal switched off", row({}, {}, { featureDealerPortal: false })],
    ["another dealer's user", row({ dealerId: "dealer-2" })],
    ["another lender's user", row({ tenantId: "tenant-2" })],
    ["no such dealer user (a User id in a DEALER token)", null],
  ])("signs out with %s", async (_label, fresh) => {
    h.findDealerUser.mockResolvedValue(fresh)
    await expect(jwt(dealerToken())).resolves.toBeNull()
    expect(h.findUser).not.toHaveBeenCalled()
  })

  it("keeps the tenant-bound token on a transient DB failure", async () => {
    h.findDealerUser.mockRejectedValue(new Error("connection reset"))
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined)
    await expect(jwt(dealerToken())).resolves.toMatchObject({ role: "DEALER", tenantId: "tenant-1" })
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it("refuses a DEALER token with no tenant, and any DEALER token on a client-audience container", async () => {
    expect(await jwt(dealerToken({ tenantId: null }))).toBeNull()
    vi.stubEnv("APP_MODE", "client")
    h.findDealerUser.mockResolvedValue(row())
    expect(await jwt(dealerToken())).toBeNull()
    expect(await jwt({}, signInUser)).toBeNull()
  })
})

describe("staff token — never revalidated as a dealer", () => {
  it("revalidates a staff token against User only", async () => {
    h.findUser.mockResolvedValue({ active: true, role: "ADMIN", tenantId: "t1", operatorId: null, tokenVersion: 0, tenant: { status: "ACTIVE", config: null } })
    const token = await jwt({ id: "u1", role: "ADMIN", tenantId: "t1", tokenVersion: 0, totpEnrolmentRequired: false, dealerId: "dealer-1" })
    expect(token).toMatchObject({ role: "ADMIN", tenantId: "t1" })
    expect(h.findDealerUser).not.toHaveBeenCalled()
  })
})
