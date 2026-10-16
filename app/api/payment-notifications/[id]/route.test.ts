import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  allocate: vi.fn(),
  reject: vi.fn(),
  triggerNotification: vi.fn(),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: string) => h.requireApiRole(role) }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => unknown) => cb({ id: "t1" }),
}))
vi.mock("@/lib/notifications", () => ({ triggerNotification: (a: unknown) => h.triggerNotification(a) }))
vi.mock("@/lib/payments/payment-notifications", async (orig) => ({
  ...(await orig<typeof import("@/lib/payments/payment-notifications")>()),
  allocatePaymentNotification: (...a: unknown[]) => h.allocate(...a),
  rejectPaymentNotification: (...a: unknown[]) => h.reject(...a),
}))

import { PATCH } from "./route"
import { PaymentNotificationError } from "@/lib/payments/payment-notifications"

const call = (body: unknown) =>
  PATCH(new NextRequest("http://x/api/payment-notifications/pn1", { method: "PATCH", body: JSON.stringify(body) }), {
    params: Promise.resolve({ id: "pn1" }),
  })

const agent = { user: { id: "u1", email: "agent@lender.example", role: "COLLECTIONS_AGENT" } }

beforeEach(() => {
  vi.clearAllMocks()
  h.requireApiRole.mockResolvedValue(agent)
  h.triggerNotification.mockResolvedValue(undefined)
  h.allocate.mockResolvedValue({
    notification: { loanId: "l1" }, payment: { id: "pay1", amount: 84_330, allocationStatus: "ALLOCATED" }, idempotentReplay: false,
  })
  h.reject.mockResolvedValue({ id: "pn1", status: "REJECTED" })
})

describe("PATCH /api/payment-notifications/[id]", () => {
  it("is gated with the same role as capturing a payment", async () => {
    h.requireApiRole.mockResolvedValue({ error: new Response(null, { status: 403 }) })
    expect((await call({ action: "allocate" })).status).toBe(403)
    expect(h.requireApiRole).toHaveBeenCalledWith("COLLECTIONS_AGENT")
    expect(h.allocate).not.toHaveBeenCalled()
  })

  it("allocates as a receipt in this tenant and tells the client it was received", async () => {
    const res = await call({ action: "allocate", amount: 84_330, receivedAt: "2026-10-15" })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ id: "pn1", status: "ALLOCATED", paymentId: "pay1" })
    expect(h.allocate).toHaveBeenCalledWith({}, expect.objectContaining({
      tenantId: "t1", id: "pn1", amount: 84_330, paymentMethod: "EFT",
      receivedAt: new Date("2026-10-15"), actor: { id: "u1", email: "agent@lender.example" }, valueDateOverride: null,
    }))
    expect(h.triggerNotification).toHaveBeenCalledWith(expect.objectContaining({ event: "payment_received", loanId: "l1" }))
  })

  it("refuses a back-date override from a role below loan administrator", async () => {
    const res = await call({ action: "allocate", valueDateOverrideReason: "Client banked it last month" })
    expect(res.status).toBe(403)
    expect(h.allocate).not.toHaveBeenCalled()
  })

  it("rejects with a reason, and refuses a rejection without one", async () => {
    expect((await call({ action: "reject", reason: " " })).status).toBe(400)
    expect(h.reject).not.toHaveBeenCalled()
    const res = await call({ action: "reject", reason: "No such deposit on the bank statement" })
    expect(res.status).toBe(200)
    expect(h.reject).toHaveBeenCalledWith({}, expect.objectContaining({ id: "pn1", reason: "No such deposit on the bank statement" }))
  })

  it("says 409 when someone already resolved it, 404 when it is not this tenant's", async () => {
    h.allocate.mockRejectedValueOnce(new PaymentNotificationError("ALREADY_RESOLVED", "This payment notification was already allocated"))
    expect((await call({ action: "allocate" })).status).toBe(409)
    h.allocate.mockRejectedValueOnce(new PaymentNotificationError("NOT_FOUND", "Payment notification not found"))
    expect((await call({ action: "allocate" })).status).toBe(404)
  })

  it("refuses an unknown action and a bad amount", async () => {
    expect((await call({ action: "delete" })).status).toBe(400)
    expect((await call({ action: "allocate", amount: 12.5 })).status).toBe(400)
    expect(h.allocate).not.toHaveBeenCalled()
  })
})
