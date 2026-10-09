import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const applyManualReceiptMock = vi.fn()
const triggerNotificationMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/loan/apply-payment", async () => {
  const actual = await vi.importActual<typeof import("@/lib/loan/apply-payment")>("@/lib/loan/apply-payment")
  return {
    ...actual, // keep the real PaymentApplicationError class so `instanceof` works
    applyManualReceipt: (db: unknown, input: unknown) => applyManualReceiptMock(db, input),
  }
})
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (a: unknown) => triggerNotificationMock(a),
}))

import { POST } from "./route"
import { PaymentApplicationError } from "@/lib/loan/apply-payment"

function postReq(
  body: unknown,
  idempotencyKey: string | null = "550e8400-e29b-41d4-a716-446655440000",
) {
  const headers = new Headers({ "content-type": "application/json" })
  if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey)
  return new NextRequest("http://x/api/payments", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "agent-1", email: "agent@x.co", role: "COLLECTIONS_AGENT" } })
  triggerNotificationMock.mockResolvedValue(undefined)
})

it("delegates a valid keyed payment and returns the newly-created receipt", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", loanId: "loan-1", amount: 50_000 },
    idempotentReplay: false,
  })

  const res = await POST(postReq({ loanId: "loan-1", amount: 50_000, reference: "LN-1" }))

  expect(res.status).toBe(200)
  expect(applyManualReceiptMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      loanId: "loan-1",
      tenantId: "t1",
      amount: 50_000,
      paymentMethod: "EFT",
      capturedById: "agent-1",
      capturedByEmail: "agent@x.co",
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    }),
  )
  expect(res.headers.get("Idempotency-Replayed")).toBe("false")
  expect(triggerNotificationMock).toHaveBeenCalledOnce()
})

it("returns an idempotent replay without sending a second notification", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-existing", loanId: "loan-1", amount: 50_000 },
    idempotentReplay: true,
  })

  const res = await POST(postReq({ loanId: "loan-1", amount: 50_000 }))

  expect(res.status).toBe(200)
  expect((await res.json()).id).toBe("pay-existing")
  expect(res.headers.get("Idempotency-Replayed")).toBe("true")
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("rejects a missing or malformed idempotency key before touching the loan", async () => {
  const missing = await POST(postReq({ loanId: "loan-1", amount: 50_000 }, null))
  const malformed = await POST(postReq({ loanId: "loan-1", amount: 50_000 }, "too short"))

  expect(missing.status).toBe(400)
  expect(malformed.status).toBe(400)
  expect(applyManualReceiptMock).not.toHaveBeenCalled()
})

it("rejects a non-integer amount before touching the loan", async () => {
  const res = await POST(postReq({ loanId: "loan-1", amount: 50.5 }))

  expect(res.status).toBe(400)
  expect(applyManualReceiptMock).not.toHaveBeenCalled()
})

it("refuses WAIVER as a keyed payment method: a waiver is not money received", async () => {
  const res = await POST(postReq({ loanId: "loan-1", amount: 75, paymentMethod: "WAIVER" }))

  expect(res.status).toBe(400)
  expect(applyManualReceiptMock).not.toHaveBeenCalled()
})

it("rejects a missing loanId before touching the loan", async () => {
  const res = await POST(postReq({ amount: 50_000 }))

  expect(res.status).toBe(400)
  expect(applyManualReceiptMock).not.toHaveBeenCalled()
})

it("maps NOT_FOUND to 404", async () => {
  applyManualReceiptMock.mockRejectedValue(new PaymentApplicationError("NOT_FOUND", "Loan not found"))

  const res = await POST(postReq({ loanId: "nope", amount: 50_000 }))

  expect(res.status).toBe(404)
})

it("maps NOT_ACTIVE to 400", async () => {
  applyManualReceiptMock.mockRejectedValue(new PaymentApplicationError("NOT_ACTIVE", "Loan is not active"))

  const res = await POST(postReq({ loanId: "loan-1", amount: 50_000 }))

  expect(res.status).toBe(400)
})




it("reports the refund due alongside the receipt on an over-payment", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", amount: 242_567 },
    excessPayment: { id: "pay-2", amount: 7_433 },
    idempotentReplay: false,
  })

  const res = await POST(postReq({ loanId: "loan-1", amount: 250_000 }))
  const body = await res.json()

  expect(res.status).toBe(200)
  expect(body.excessPayment).toMatchObject({ amount: 7_433 })
})

it("maps idempotency-key reuse with a different request to 409", async () => {
  applyManualReceiptMock.mockRejectedValue(
    new PaymentApplicationError(
      "IDEMPOTENCY_CONFLICT",
      "This idempotency key was already used for a different payment request.",
    ),
  )

  const res = await POST(postReq({ loanId: "loan-1", amount: 50_000 }))

  expect(res.status).toBe(409)
  expect((await res.json()).error).toMatch(/different payment request/i)
  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("propagates an unexpected error as a 500", async () => {
  applyManualReceiptMock.mockRejectedValue(new Error("db exploded"))

  const res = await POST(postReq({ loanId: "loan-1", amount: 50_000 }))

  expect(res.status).toBe(500)
})

// payment_received asserts the account is updated and quotes an outstanding
// balance. That is a plain untruth only when NOTHING was allocated and the loan
// was never written — so suppression is scoped to that case alone.
it("still notifies on a SPLIT receipt, which settles the loan", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", amount: 242_567, allocationStatus: "ALLOCATED" },
    excessPayment: { id: "pay-2", amount: 7_433 },
    idempotentReplay: false,
  })

  const res = await POST(postReq({ loanId: "loan-1", amount: 250_000 }))

  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ refundDueAmount: 7_433 })
  // Suppressing here would mean a client who over-pays by a cent settles their
  // loan and is never told, on any channel: payment_received is the only
  // customer-facing receipt event, and reconcile cannot re-emit it for a split
  // sibling (allocate 409s once the split has closed the loan).
  expect(triggerNotificationMock).toHaveBeenCalledWith(
    expect.objectContaining({ event: "payment_received" }),
  )
})

it("does NOT notify when the whole receipt is refund-due", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", amount: 50_000, allocationStatus: "UNAPPLIED" },
    excessPayment: null,
    idempotentReplay: false,
  })

  await POST(postReq({ loanId: "loan-1", amount: 50_000 }))

  expect(triggerNotificationMock).not.toHaveBeenCalled()
})

it("still notifies on an ordinary fully-allocated receipt", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", amount: 50_000, allocationStatus: "ALLOCATED" },
    excessPayment: null,
    idempotentReplay: false,
  })

  await POST(postReq({ loanId: "loan-1", amount: 50_000 }))

  expect(triggerNotificationMock).toHaveBeenCalledWith(
    expect.objectContaining({ event: "payment_received" }),
  )
})

// Dating a receipt back far enough to write off material interest is the one
// thing on this endpoint that needs a senior name against it. The gate had no
// test at all: deleting it, or lowering it to COLLECTIONS_AGENT, left the whole
// suite green.
it("refuses a back-date override from a collections agent", async () => {
  requireApiRoleMock.mockResolvedValue({
    user: { id: "agent-1", email: "agent@x.co", role: "COLLECTIONS_AGENT" },
  })

  const res = await POST(postReq({
    loanId: "loan-1",
    amount: 50_000,
    receivedAt: "2026-07-01",
    valueDateOverrideReason: "Deposit slip surfaced during the branch reconciliation.",
  }))

  expect(res.status).toBe(403)
  expect(await res.json()).toMatchObject({ error: expect.stringContaining("loan administrator") })
  // Nothing may be captured on a refused authorisation.
  expect(applyManualReceiptMock).not.toHaveBeenCalled()
})

it("accepts a back-date override from a loan administrator", async () => {
  requireApiRoleMock.mockResolvedValue({
    user: { id: "admin-1", email: "admin@x.co", role: "LOAN_ADMIN" },
  })
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", amount: 50_000, allocationStatus: "ALLOCATED" },
    excessPayment: null,
    idempotentReplay: false,
  })

  const res = await POST(postReq({
    loanId: "loan-1",
    amount: 50_000,
    receivedAt: "2026-07-01",
    valueDateOverrideReason: "Deposit slip surfaced during the branch reconciliation.",
  }))

  expect(res.status).toBe(200)
  // The approver is the SESSION user, never caller-supplied.
  expect(applyManualReceiptMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      valueDateOverride: expect.objectContaining({
        approvedById: "admin-1",
        approvedByEmail: "admin@x.co",
      }),
    }),
  )
})

it("passes the value date through without an override when none is claimed", async () => {
  applyManualReceiptMock.mockResolvedValue({
    payment: { id: "pay-1", amount: 50_000, allocationStatus: "ALLOCATED" },
    excessPayment: null,
    idempotentReplay: false,
  })

  await POST(postReq({ loanId: "loan-1", amount: 50_000, receivedAt: "2026-07-18" }))

  expect(applyManualReceiptMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      receivedAt: new Date("2026-07-18"),
      valueDateOverride: null,
    }),
  )
})
