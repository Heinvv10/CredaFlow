import { describe, it, expect, vi, beforeEach } from "vitest"

// Hoist mock functions so they're available inside vi.mock() factory closures.
const { mockFindUnique, mockUpdateMany } = vi.hoisted(() => ({
  mockFindUnique: vi.fn(),
  mockUpdateMany: vi.fn(),
}))

// Mock NextAuth and Next.js so auth.ts can be imported in isolation.
vi.mock("next-auth", () => ({ default: vi.fn(() => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() })), CredentialsSignin: class {} }))
vi.mock("next-auth/providers/credentials", () => ({ default: vi.fn() }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn() } }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: mockFindUnique, updateMany: mockUpdateMany },
    tenantConfig: { findUnique: async () => ({ requireStaffTotp: false }) },
  },
}))

import { revalidatePrincipal, claimTotpCounter } from "../auth"

// ---------------------------------------------------------------------------
// revalidatePrincipal
// ---------------------------------------------------------------------------

describe("revalidatePrincipal", () => {
  beforeEach(() => { mockFindUnique.mockReset() })

  it("returns the user's current role on success", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      role: "LOAN_ADMIN",
      tenantId: "tenant-1",
      tokenVersion: 1,
    })
    const result = await revalidatePrincipal("user-1", 1)
    expect(result).toEqual({ role: "LOAN_ADMIN", tenantId: "tenant-1", operatorId: null, totpEnrolmentRequired: false })
  })

  it("returns null when user is not found", async () => {
    mockFindUnique.mockResolvedValue(null)
    expect(await revalidatePrincipal("user-1", 1)).toBeNull()
  })

  it("returns null when user is inactive (force sign-out)", async () => {
    mockFindUnique.mockResolvedValue({
      active: false,
      role: "CREDIT_OFFICER",
      tenantId: "tenant-1",
      tokenVersion: 1,
    })
    expect(await revalidatePrincipal("user-1", 1)).toBeNull()
  })

  it("returns null when staff has no persisted tenant (force sign-out)", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      role: "LOAN_ADMIN",
      tenantId: null,
      tokenVersion: 1,
    })
    expect(await revalidatePrincipal("user-1", 1)).toBeNull()
  })

  it("returns null when tokenVersion is mismatched (revocation)", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      role: "CREDIT_OFFICER",
      tenantId: "tenant-1",
      tokenVersion: 2,
    })
    expect(await revalidatePrincipal("user-1", 1)).toBeNull()
  })

  it("returns the updated role if admin changed it mid-session", async () => {
    mockFindUnique.mockResolvedValue({
      active: true,
      role: "BRANCH_MANAGER",
      tenantId: "tenant-2",
      tokenVersion: 1,
    })
    const result = await revalidatePrincipal("user-1", 1)
    expect(result).toEqual({ role: "BRANCH_MANAGER", tenantId: "tenant-2", operatorId: null, totpEnrolmentRequired: false })
  })

  it("returns 'error' on DB failure without forcing sign-out", async () => {
    mockFindUnique.mockRejectedValue(new Error("connection refused"))
    const result = await revalidatePrincipal("user-1", 1)
    expect(result).toBe("error")
  })
})

// ---------------------------------------------------------------------------
// claimTotpCounter
// ---------------------------------------------------------------------------

describe("claimTotpCounter", () => {
  beforeEach(() => { mockUpdateMany.mockReset() })

  it("returns true when the counter is claimed (first use)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    expect(await claimTotpCounter("user-1", 100)).toBe(true)
  })

  it("returns false when count is 0 — counter already claimed (replay)", async () => {
    mockUpdateMany.mockResolvedValue({ count: 0 })
    expect(await claimTotpCounter("user-1", 100)).toBe(false)
  })

  it("passes the correct WHERE clause for atomic claim", async () => {
    mockUpdateMany.mockResolvedValue({ count: 1 })
    await claimTotpCounter("user-99", 42)
    expect(mockUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "user-99",
        OR: [{ lastTotpCounter: null }, { lastTotpCounter: { lt: 42 } }],
      },
      data: { lastTotpCounter: 42 },
    })
  })
})
