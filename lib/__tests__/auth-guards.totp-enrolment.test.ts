import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockRedirect } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockRedirect: vi.fn() }))

vi.mock("next/navigation", () => ({ redirect: (to: string) => mockRedirect(to) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: mockAuth, AppRole: undefined }))

import { requireApiRole, requireMinRole, requireOwnerOrStaff, requireRole } from "../auth-guards"

const staff = (extra: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "admin@lender.example", name: "A", role: "SUPER_ADMIN", tenantId: "t1", ...extra },
})
const FORCED = staff({ totpEnrolmentRequired: true })

beforeEach(() => {
  mockAuth.mockReset()
  mockRedirect.mockReset().mockImplementation((to: string) => { throw new Error(`REDIRECT ${to}`) })
})

// proxy.ts holds the line for every route; the guards are the second layer
// for the routes and pages that use them.
describe("a session held at TOTP enrolment (session.user.totpEnrolmentRequired)", () => {
  it("is refused by requireApiRole with 403 and the enrolment code, whatever the role", async () => {
    mockAuth.mockResolvedValue(FORCED)
    const guard = await requireApiRole("READONLY")
    expect(guard.error?.status).toBe(403)
    expect(await guard.error?.json()).toEqual({ error: "Two-factor enrolment required", code: "totp_enrolment_required" })
    expect(guard.user).toBeUndefined()
  })

  it("is sent to the enrolment page by requireRole and requireMinRole", async () => {
    mockAuth.mockResolvedValue(FORCED)
    await expect(requireRole(["SUPER_ADMIN"])).rejects.toThrow("REDIRECT /settings/security")
    await expect(requireMinRole("READONLY")).rejects.toThrow("REDIRECT /settings/security")
  })

  it("is refused by requireOwnerOrStaff as staff", async () => {
    mockAuth.mockResolvedValue(FORCED)
    const result = await requireOwnerOrStaff("client-1")
    expect(result.error?.status).toBe(403)
  })

  it("passes every guard when the claim is false or absent", async () => {
    for (const session of [staff(), staff({ totpEnrolmentRequired: false })]) {
      mockAuth.mockResolvedValue(session)
      expect((await requireApiRole("READONLY")).user?.id).toBe("u1")
      expect((await requireMinRole("READONLY")).id).toBe("u1")
      expect((await requireRole(["SUPER_ADMIN"])).id).toBe("u1")
      expect((await requireOwnerOrStaff("client-1")).type).toBe("staff")
    }
  })

  it("does not touch a CLIENT session", async () => {
    mockAuth.mockResolvedValue({ user: { id: "client-1", email: "c@x.example", role: "CLIENT", tenantId: "t1" } })
    expect(await requireOwnerOrStaff("client-1")).toMatchObject({ type: "client", clientId: "client-1" })
  })
})
