import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockRedirect, stamp } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn(),
  stamp: { path: null as string | null, scope: true },
}))

vi.mock("next/navigation", () => ({ redirect: (to: string) => mockRedirect(to) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: mockAuth, AppRole: undefined }))
vi.mock("next/headers", () => ({
  headers: async () => {
    if (!stamp.scope) throw new Error("headers() was called outside a request scope")
    return new Headers(stamp.path === null ? {} : { "x-cf-request-path": stamp.path })
  },
}))

import { requireApiRole, requireLoanBookPage, requireMinRole, requireOwnerOrStaff } from "../auth-guards"

const as = (role: string) => mockAuth.mockResolvedValue({ user: { id: "u1", email: "u1@lender.example", name: "U", role, tenantId: "t1" } })

beforeEach(() => {
  mockAuth.mockReset()
  mockRedirect.mockReset().mockImplementation((to: string) => { throw new Error(`REDIRECT ${to}`) })
  stamp.path = null
  stamp.scope = true
})

// The second layer behind proxy.ts (security review of #145): the guards
// refuse a role without view_loan_book on a loan-book path, from the path the
// proxy stamped, and fail closed when there is no stamp.
describe("requireApiRole for INSURANCE_OFFICER", () => {
  it.each(["/api/insurance/claims", "/api/clients/c1", "/api/notifications"])("lets it through on %s", async (path) => {
    as("INSURANCE_OFFICER")
    stamp.path = path
    expect((await requireApiRole("READONLY")).user?.id).toBe("u1")
  })

  it.each(["/api/loans/l1", "/api/applications", "/api//loans/l1", "/api/%6Coans/l1", "/api/loans/", "/api/payment-notifications/p1", "/api/insurance/../loans/l1", "/api/%E0%A4%A"])(
    "refuses %s with 403", async (path) => {
      as("INSURANCE_OFFICER")
      stamp.path = path
      expect((await requireApiRole("READONLY")).error?.status).toBe(403)
    },
  )

  it("fails closed with no stamped path, and outside a request scope", async () => {
    as("INSURANCE_OFFICER")
    expect((await requireApiRole("READONLY")).error?.status).toBe(403)
    stamp.scope = false
    expect((await requireApiRole("READONLY")).error?.status).toBe(403)
  })

  it("does not touch a role that reads the loan book, stamp or none", async () => {
    as("CREDIT_OFFICER")
    expect((await requireApiRole("READONLY")).user?.id).toBe("u1")
    stamp.path = "/api/loans/l1"
    expect((await requireApiRole("READONLY")).user?.id).toBe("u1")
  })
})

describe("page and mixed-caller guards for INSURANCE_OFFICER", () => {
  it("requireMinRole sends a loan-book page to the no-access page and opens the rest", async () => {
    as("INSURANCE_OFFICER")
    stamp.path = "/loans/l1"
    await expect(requireMinRole("READONLY")).rejects.toThrow("REDIRECT /no-access")
    stamp.path = "/insurance/claims"
    expect((await requireMinRole("READONLY")).id).toBe("u1")
  })

  it("requireOwnerOrStaff refuses its staff caller on a loan-book API", async () => {
    as("INSURANCE_OFFICER")
    stamp.path = "/api/loans/l1/statement"
    expect((await requireOwnerOrStaff("client-1")).error?.status).toBe(403)
  })

  it("requireLoanBookPage redirects it, from the dashboard to its own home", async () => {
    as("INSURANCE_OFFICER")
    await expect(requireLoanBookPage()).rejects.toThrow("REDIRECT /no-access")
    await expect(requireLoanBookPage({ home: true })).rejects.toThrow("REDIRECT /clients")
    as("LOAN_ADMIN")
    await expect(requireLoanBookPage()).resolves.toBeUndefined()
  })
})
