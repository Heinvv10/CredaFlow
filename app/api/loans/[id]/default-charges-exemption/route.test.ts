import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const { requireApiRole, transaction } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  transaction: vi.fn(),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) =>
    await handler({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: transaction } }))

import { PATCH } from "./route"

const call = (body: unknown) => PATCH(
  new NextRequest("http://localhost/api/loans/loan-1/default-charges-exemption", {
    method: "PATCH", body: JSON.stringify(body),
  }),
  { params: Promise.resolve({ id: "loan-1" }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRole.mockResolvedValue({ error: null, user: { id: "u1", email: "admin@test.invalid" } })
})

describe("PATCH /api/loans/[id]/default-charges-exemption", () => {
  it("requires LOAN_ADMIN, like the other loan-servicing mutations", async () => {
    requireApiRole.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    expect((await call({ exempt: true, reason: "A sufficient reason" })).status).toBe(403)
    expect(requireApiRole).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(transaction).not.toHaveBeenCalled()
  })

  it.each([
    [{ exempt: true }],
    [{ exempt: true, reason: "   " }],
    [{ exempt: "yes", reason: "A sufficient reason" }],
    [{ exempt: true, reason: "x".repeat(501) }],
  ])("refuses %j without writing", async (body) => {
    expect((await call(body)).status).toBe(422)
    expect(transaction).not.toHaveBeenCalled()
  })
})
