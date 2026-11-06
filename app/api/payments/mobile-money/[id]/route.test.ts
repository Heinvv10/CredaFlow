import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const { requireApiRole, allocateMobileMoney, rejectMobileMoney, notifyReceiptBooked } = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  allocateMobileMoney: vi.fn(),
  rejectMobileMoney: vi.fn(),
  notifyReceiptBooked: vi.fn(),
}))
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole,
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_r: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/mobile-money/review", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/mobile-money/review")>()),
  allocateMobileMoney, rejectMobileMoney,
}))
vi.mock("@/lib/mobile-money/notify", () => ({ notifyReceiptBooked }))

import { PATCH } from "./route"
import { MobileMoneyReviewError } from "@/lib/mobile-money/review"

const patch = (body: unknown) => PATCH(
  new NextRequest("http://x/api/payments/mobile-money/mm1", { method: "PATCH", body: typeof body === "string" ? body : JSON.stringify(body) }),
  { params: Promise.resolve({ id: "mm1" }) },
)

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRole.mockResolvedValue({ user: { id: "u1", email: "agent@test.invalid", role: "COLLECTIONS_AGENT" } })
  allocateMobileMoney.mockResolvedValue({ transactionId: "mm1", loanId: "l1", payment: { id: "p1", amount: 100, allocationStatus: "ALLOCATED" }, idempotentReplay: false })
  rejectMobileMoney.mockResolvedValue({ transactionId: "mm1", status: "REJECTED" })
})

describe("PATCH /api/payments/mobile-money/[id]", () => {
  it("allocates to the loan staff name, for this lender, and tells the client", async () => {
    const res = await patch({ action: "allocate", loanReference: "NRB-LN-1" })
    expect(res.status).toBe(200)
    expect(allocateMobileMoney.mock.calls[0][1]).toEqual({ tenantId: "t1", id: "mm1", loanReference: "NRB-LN-1", actor: { id: "u1", email: "agent@test.invalid" } })
    expect(notifyReceiptBooked).toHaveBeenCalledWith({ tenantId: "t1", loanId: "l1", payment: expect.objectContaining({ id: "p1" }) })
  })

  it("rejects with a reason, and refuses one too short", async () => {
    expect((await patch({ action: "reject", reason: "no" })).status).toBe(400)
    const res = await patch({ action: "reject", reason: "Not our customer: refunded by Safaricom" })
    expect(res.status).toBe(200)
    expect(rejectMobileMoney.mock.calls[0][1]).toMatchObject({ tenantId: "t1", id: "mm1", reason: "Not our customer: refunded by Safaricom" })
  })

  it("refuses a role that cannot record payments", async () => {
    requireApiRole.mockResolvedValue({ user: { id: "u2", email: "i@test.invalid", role: "INSURANCE_OFFICER" } })
    expect((await patch({ action: "allocate", loanReference: "NRB-LN-1" })).status).toBe(403)
    expect(allocateMobileMoney).not.toHaveBeenCalled()
  })

  it("answers 400 to a body that is not JSON, an unknown action or no loan reference", async () => {
    expect((await patch("{nope")).status).toBe(400)
    expect((await patch({ action: "book" })).status).toBe(400)
    expect((await patch({ action: "allocate", loanReference: "  " })).status).toBe(400)
  })

  it("maps review refusals: resolved 409, missing 404, simulated 409", async () => {
    allocateMobileMoney.mockRejectedValueOnce(new MobileMoneyReviewError("ALREADY_RESOLVED", "already booked"))
    expect((await patch({ action: "allocate", loanReference: "NRB-LN-1" })).status).toBe(409)
    allocateMobileMoney.mockRejectedValueOnce(new MobileMoneyReviewError("LOAN_NOT_FOUND", "no loan"))
    expect((await patch({ action: "allocate", loanReference: "NRB-LN-9" })).status).toBe(404)
    allocateMobileMoney.mockRejectedValueOnce(new MobileMoneyReviewError("SIMULATION_FORBIDDEN", "simulated"))
    expect((await patch({ action: "allocate", loanReference: "NRB-LN-1" })).status).toBe(409)
    expect(notifyReceiptBooked).not.toHaveBeenCalled()
  })
})
