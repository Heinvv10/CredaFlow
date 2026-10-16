import { beforeEach, describe, expect, it, vi } from "vitest"

const { mockAuth, mockRedirect } = vi.hoisted(() => ({ mockAuth: vi.fn(), mockRedirect: vi.fn() }))

vi.mock("next/navigation", () => ({ redirect: (to: string) => mockRedirect(to) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/auth", () => ({ auth: mockAuth, AppRole: undefined }))

import { NO_ACCESS_PAGE, requireMinRole, requireRole } from "../auth-guards"

beforeEach(() => {
  mockAuth.mockReset().mockResolvedValue({
    user: { id: "u1", email: "loan.admin@lender.example", name: "L", role: "LOAN_ADMIN", tenantId: "t1" },
  })
  mockRedirect.mockReset().mockImplementation((to: string) => { throw new Error(`REDIRECT ${to}`) })
})

// Fair Score audit (2026-10-16): a LOAN_ADMIN opening /settings/users was sent
// to "/", which rendered the PUBLIC marketing website inside the staff app.
describe("a staff page the role cannot open", () => {
  it("sends the user to the staff no-access page, never the site root", async () => {
    expect(NO_ACCESS_PAGE).toBe("/no-access")
    await expect(requireMinRole("BRANCH_MANAGER")).rejects.toThrow("REDIRECT /no-access")
    await expect(requireRole(["ADMIN", "SUPER_ADMIN"])).rejects.toThrow("REDIRECT /no-access")
  })

  it("lets a role that may open it through", async () => {
    expect((await requireMinRole("LOAN_ADMIN")).id).toBe("u1")
  })
})
