import { describe, it, expect, vi, beforeEach } from "vitest"

const { mockGetSession, mockGetDefaultTenantId } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetDefaultTenantId: vi.fn(async () => "tenant-default"),
}))

// redirect() throws in Next; the mock throws a recognisable error so a test
// can assert both that the helper stopped and where it sent the user.
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`)
  }),
}))
vi.mock("next/server", () => ({ NextResponse: { json: vi.fn() } }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/auth-session", () => ({ getSession: mockGetSession }))
// The helpers must never consult the deployment default. Mocked so that a
// regression which falls back to it returns a value instead of throwing on a
// missing NEXT_PUBLIC_TENANT_SLUG, and the tests below see the difference.
vi.mock("@/lib/tenant", () => ({ getDefaultTenantId: mockGetDefaultTenantId }))

import { getStaffTenantId, getPortalTenantId } from "./session-tenant"

function session(user: { role: string; tenantId: string | null } | null) {
  return user ? { user: { id: "u-1", email: "u@example.test", ...user } } : null
}

beforeEach(() => {
  mockGetSession.mockReset()
  mockGetDefaultTenantId.mockClear()
})

describe("getStaffTenantId", () => {
  it("returns the staff session's tenant", async () => {
    mockGetSession.mockResolvedValue(session({ role: "LOAN_ADMIN", tenantId: "tenant-b" }))
    await expect(getStaffTenantId()).resolves.toBe("tenant-b")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })

  it("no session → the stale-session route, not the default tenant", async () => {
    mockGetSession.mockResolvedValue(null)
    await expect(getStaffTenantId()).rejects.toThrow("REDIRECT:/api/auth/expired")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })

  it("session without a tenant → the stale-session route, not the default tenant", async () => {
    mockGetSession.mockResolvedValue(session({ role: "LOAN_ADMIN", tenantId: null }))
    await expect(getStaffTenantId()).rejects.toThrow("REDIRECT:/api/auth/expired")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })

  it("a CLIENT session → /portal (staff pages are not read for clients)", async () => {
    mockGetSession.mockResolvedValue(session({ role: "CLIENT", tenantId: "tenant-b" }))
    await expect(getStaffTenantId()).rejects.toThrow("REDIRECT:/portal")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })
})

describe("getPortalTenantId", () => {
  it("returns the client session's tenant", async () => {
    mockGetSession.mockResolvedValue(session({ role: "CLIENT", tenantId: "tenant-b" }))
    await expect(getPortalTenantId()).resolves.toBe("tenant-b")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })

  it("no session → /portal/login, not the default tenant", async () => {
    mockGetSession.mockResolvedValue(null)
    await expect(getPortalTenantId()).rejects.toThrow("REDIRECT:/portal/login")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })

  // Not /portal/login: that page sends a signed-in client back to /portal, a
  // loop. The stale-session route clears the cookie first.
  it("client session without a tenant → the stale-session route, not the default tenant", async () => {
    mockGetSession.mockResolvedValue(session({ role: "CLIENT", tenantId: null }))
    await expect(getPortalTenantId()).rejects.toThrow("REDIRECT:/api/auth/expired")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })

  it("a staff session → /dashboard (portal pages are not read for staff)", async () => {
    mockGetSession.mockResolvedValue(session({ role: "LOAN_ADMIN", tenantId: "tenant-b" }))
    await expect(getPortalTenantId()).rejects.toThrow("REDIRECT:/dashboard")
    expect(mockGetDefaultTenantId).not.toHaveBeenCalled()
  })
})
