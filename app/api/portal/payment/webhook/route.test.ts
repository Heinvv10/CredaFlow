import { it, expect, vi, beforeEach } from "vitest"
import { createHmac } from "node:crypto"

const findUniqueStitchMock = vi.fn()
const stitchUpdateManyMock = vi.fn()
const paymentCreateMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const scheduleUpdateMock = vi.fn()
const loanUpdateMock = vi.fn()
const auditCreateMock = vi.fn()
const triggerNotificationMock = vi.fn()
const tenantSeenByLoanReadMock = vi.fn()
const executeRawUnsafeMock = vi.fn()
const loadWebhookSecretMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    stitchPaymentRequest: {
      findUnique: (a: unknown) => findUniqueStitchMock(a),
    },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        // The tx takes a FOR UPDATE lock on the loan first.
        $queryRaw: () => Promise.resolve([]),
        $executeRawUnsafe: (statement: string) =>
          executeRawUnsafeMock(statement),
        stitchPaymentRequest: {
          updateMany: (a: unknown) => stitchUpdateManyMock(a),
        },
        payment: {
          create: (a: { data: Record<string, unknown> }) => {
            paymentCreateMock(a)
            return Promise.resolve({ id: "pay-1", ...a.data })
          },
        },
        loan: {
          findUnique: (a: unknown) => {
            tenantSeenByLoanReadMock(getCurrentTenantId())
            return loanFindUniqueMock(a)
          },
          update: (a: unknown) => {
            loanUpdateMock(a)
            return Promise.resolve({})
          },
        },
        repaymentSchedule: {
          update: (a: unknown) => {
            scheduleUpdateMock(a)
            return Promise.resolve({})
          },
        },
        auditLog: {
          create: (a: unknown) => {
            auditCreateMock(a)
            return Promise.resolve({ id: "audit-1" })
          },
        },
      }),
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: { PAYMENT_RECORDED: "PAYMENT_RECORDED" },
}))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (a: unknown) => triggerNotificationMock(a),
}))
vi.mock("@/lib/stitch", () => ({
  loadStitchWebhookSecret: (tenantId: string | null) => loadWebhookSecretMock(tenantId),
}))

import { POST } from "./route"
import { getCurrentTenantId } from "@/lib/tenant-scope"

const SECRET = "test-secret"

function makeReq(payload: unknown, opts?: { badSignature?: boolean; noSignature?: boolean; secret?: string }) {
  const body = JSON.stringify(payload)
  const signature = opts?.noSignature
    ? undefined
    : opts?.badSignature
      ? "0".repeat(64)
      : createHmac("sha256", opts?.secret ?? SECRET).update(body).digest("hex")
  const headers: Record<string, string> = {}
  if (signature) headers["x-stitch-signature"] = signature
  return new Request("http://localhost/api/portal/payment/webhook", {
    method: "POST",
    body,
    headers,
  })
}

function stitchPayment(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "spr-1",
    stitchId: "stitch-123",
    loanId: "loan-1",
    clientId: "client-1",
    amount: 50_000,
    status: "PENDING",
    externalReference: "REF-1",
    createdAt: new Date(),
    loan: { tenantId: "t1" },
    ...overrides,
  }
}

function makeLoan(status: string, overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "loan-1",
    status,
    principal: 500_000,
    totalInterest: 120_000,
    totalPaid: 100_000,
    totalRepayable: 600_000,
    contractualTotalInterest: null,
    contractualTotalRepayable: null,
    interestRatePm: 0.05,
    interestModel: "FLAT",
    startDate: new Date("2025-12-01T00:00:00.000Z"),
    maturityDate: new Date("2026-02-01T00:00:00.000Z"),
    closedAt: null,
    repaymentSchedule: [
      {
        id: "sched-1",
        dueDate: new Date("2026-01-01"),
        principalDue: 150_000,
        interestDue: 40_000,
        feesDue: 10_000,
        totalDue: 200_000,
        totalPaid: 100_000,
      },
      {
        id: "sched-2",
        dueDate: new Date("2026-02-01"),
        principalDue: 300_000,
        interestDue: 80_000,
        feesDue: 20_000,
        totalDue: 400_000,
        totalPaid: 0,
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  loadWebhookSecretMock.mockResolvedValue(SECRET)
  triggerNotificationMock.mockResolvedValue(undefined)
  stitchUpdateManyMock.mockResolvedValue({ count: 1 })
})

it("returns 401 on a bad signature and writes nothing", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  const res = await POST(
    makeReq({ type: "payment.completed", data: { id: "stitch-123" } }, { badSignature: true })
  )
  expect(res.status).toBe(401)
  expect(paymentCreateMock).not.toHaveBeenCalled()
  expect(stitchUpdateManyMock).not.toHaveBeenCalled()
})

// Each lender signs with its own Stitch account's secret.
it("verifies with the paying lender's own secret, and refuses another lender's", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment({ loan: { tenantId: "t2" } }))
  loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE"))
  loadWebhookSecretMock.mockImplementation(async (tenantId: string | null) => (tenantId === "t2" ? "t2-secret" : SECRET))
  const payload = { type: "payment.completed", data: { id: "stitch-123" } }

  const forged = await POST(makeReq(payload))
  expect(forged.status).toBe(401)
  expect(paymentCreateMock).not.toHaveBeenCalled()

  const genuine = await POST(makeReq(payload, { secret: "t2-secret" }))
  expect(genuine.status).toBe(200)
  expect(loadWebhookSecretMock).toHaveBeenCalledWith("t2")
  expect(paymentCreateMock).toHaveBeenCalledTimes(1)
})

// An unknown payment and a lender without a secret answer alike, so the
// response tells a prober nothing about which payment ids exist.
it("answers 401, logs, and writes nothing when the paying lender has no webhook secret", async () => {
  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  loadWebhookSecretMock.mockResolvedValue(null)
  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: "Invalid signature" })
  expect(paymentCreateMock).not.toHaveBeenCalled()
  expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no Stitch webhook secret"), "t1")
  errorSpy.mockRestore()
})

// Event types we do not act on get a 200 so Stitch does not retry them; no
// lookup and no write happens, so no signature is needed to say "ignored".
it.each([
  ["payment.failed", { type: "payment.failed", data: { id: "stitch-123" } }],
  ["an event with no data", { type: "refund.completed" }],
])("acknowledges %s with 200 and processes nothing", async (_label, payload) => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  const res = await POST(makeReq(payload, { badSignature: true }))
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ ok: true })
  expect(findUniqueStitchMock).not.toHaveBeenCalled()
  expect(loadWebhookSecretMock).not.toHaveBeenCalled()
  expect(paymentCreateMock).not.toHaveBeenCalled()
})

it.each([
  ["invalid JSON", "{not json"],
  ["a JSON array", "[]"],
  ["an event without a type", JSON.stringify({ data: { id: "stitch-123" } })],
])("answers 400 to %s", async (_label, body) => {
  const res = await POST(new Request("http://localhost/api/portal/payment/webhook", {
    method: "POST", body, headers: { "x-stitch-signature": "0".repeat(64) },
  }))
  expect(res.status).toBe(400)
  expect(findUniqueStitchMock).not.toHaveBeenCalled()
  expect(paymentCreateMock).not.toHaveBeenCalled()
})

it("answers 401 to a payment.completed that names no payment id", async () => {
  const res = await POST(makeReq({ type: "payment.completed", data: {} }))
  expect(res.status).toBe(401)
  expect(paymentCreateMock).not.toHaveBeenCalled()
})

it("answers 401 to an event that names no payment of ours, without looking for any secret", async () => {
  findUniqueStitchMock.mockResolvedValue(null)
  const res = await POST(makeReq({ type: "payment.completed", data: { id: "unknown" } }))
  expect(res.status).toBe(401)
  expect(await res.json()).toEqual({ error: "Invalid signature" })
  expect(loadWebhookSecretMock).not.toHaveBeenCalled()
})

it("allocates the receipt earliest-first and updates loan balances on an ACTIVE loan", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE"))

  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

  expect(res.status).toBe(200)
  expect(paymentCreateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        loanId: "loan-1",
        amount: 50_000,
        paymentMethod: "EFT",
        allocationStatus: "ALLOCATED",
      }),
    })
  )
  // 50_000 fills the remainder of sched-1 (100_000 due) partially -> PARTIAL
  expect(scheduleUpdateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { id: "sched-1", tenantId: "t1" },
      data: expect.objectContaining({ totalPaid: 150_000, status: "PARTIAL" }),
    })
  )
  expect(scheduleUpdateMock).not.toHaveBeenCalledWith(
    expect.objectContaining({ where: { id: "sched-2", tenantId: "t1" } })
  )
  expect(loanUpdateMock).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({
        totalPaid: 150_000,
        status: "ACTIVE",
      }),
    })
  )
  const updateData = loanUpdateMock.mock.calls[0][0].data
  expect(updateData).not.toHaveProperty("contractualTotalInterest")
  expect(updateData).not.toHaveProperty("contractualTotalRepayable")
  expect(auditCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      tenantId: "t1",
      userId: null,
      action: "PAYMENT_RECORDED",
      entity: "Loan",
      entityId: "loan-1",
      newValue: expect.objectContaining({
        paymentId: "pay-1",
        amount: 50_000,
        method: "EFT",
        reference: "REF-1",
        source: "stitch_webhook",
        allocated: true,
      }),
    }),
  })
  expect(executeRawUnsafeMock).toHaveBeenLastCalledWith(
    "SET CONSTRAINTS ALL IMMEDIATE",
  )
})

it("dates the receipt and the instalment it completes at the same instant", async () => {
  // Every argument-less Date is a millisecond later than the one before, so
  // two separate `new Date()` reads can never agree by accident.
  const RealDate = Date
  let tick = RealDate.parse("2026-01-10T08:00:00.000Z")
  vi.stubGlobal("Date", class extends RealDate {
    constructor(...args: ConstructorParameters<typeof RealDate> | []) {
      if (args.length === 0) super(tick++)
      else super(...(args as ConstructorParameters<typeof RealDate>))
    }
  })
  try {
    findUniqueStitchMock.mockResolvedValue(stitchPayment({ amount: 100_000 }))
    loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE"))

    const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

    expect(res.status).toBe(200)
    const receivedAt = paymentCreateMock.mock.calls[0][0].data.receivedAt as Date
    expect(scheduleUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "sched-1", tenantId: "t1" },
      data: expect.objectContaining({ status: "PAID", paidAt: receivedAt }),
    }))
  } finally {
    vi.unstubAllGlobals()
  }
})

it("allocates the receipt on a DEFAULTED loan", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  loanFindUniqueMock.mockResolvedValue(makeLoan("DEFAULTED"))

  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

  expect(res.status).toBe(200)
  expect(scheduleUpdateMock).toHaveBeenCalled()
  expect(loanUpdateMock).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "DEFAULTED" }) })
  )
})

it("keeps the Payment receipt but skips allocation on a PENDING_WRITE_OFF loan, logging loudly", async () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  loanFindUniqueMock.mockResolvedValue(makeLoan("PENDING_WRITE_OFF"))

  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

  expect(res.status).toBe(200)
  expect(paymentCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      allocationStatus: "UNAPPLIED",
      reconciliationReason: "loan_not_allocatable",
    }),
  })
  expect(scheduleUpdateMock).not.toHaveBeenCalled()
  expect(loanUpdateMock).not.toHaveBeenCalled()
  expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/non-allocatable loan status=PENDING_WRITE_OFF/))
  // Receipt still needs to be reconciliation-visible via audit.
  expect(auditCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      newValue: expect.objectContaining({
        paymentId: "pay-1",
        allocated: false,
        reconciliationRequired: true,
      }),
    }),
  })
  expect(triggerNotificationMock).not.toHaveBeenCalled()
  errSpy.mockRestore()
})

it("records a concurrent overpayment as structured UNAPPLIED money", async () => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  findUniqueStitchMock.mockResolvedValue(stitchPayment({ amount: 550_000 }))
  loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE"))

  const res = await POST(
    makeReq({ type: "payment.completed", data: { id: "stitch-123" } }),
  )

  expect(res.status).toBe(200)
  expect(paymentCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      amount: 550_000,
      allocationStatus: "UNAPPLIED",
      reconciliationReason: "amount_exceeds_current_settlement",
    }),
  })
  expect(scheduleUpdateMock).not.toHaveBeenCalled()
  expect(loanUpdateMock).not.toHaveBeenCalled()
  expect(auditCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      newValue: expect.objectContaining({
        allocated: false,
        reconciliationRequired: true,
        reason: "amount_exceeds_current_settlement",
      }),
    }),
  })
  expect(triggerNotificationMock).not.toHaveBeenCalled()
  errSpy.mockRestore()
})

it("flips loan status to COMPLETED on full settlement", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment({ amount: 500_000 }))
  loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE"))

  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

  expect(res.status).toBe(200)
  expect(loanUpdateMock).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ status: "COMPLETED" }) })
  )
})

it("applies only accrued interest to a day-15 daily-accrual settlement", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"))
  findUniqueStitchMock.mockResolvedValue(stitchPayment({ amount: 241_900 }))
  loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE", {
    principal: 200_000,
    totalInterest: 10_000,
    totalPaid: 0,
    totalRepayable: 246_900,
    interestModel: "DAILY_ACCRUAL",
    startDate: new Date("2026-07-01T08:00:00.000Z"),
    maturityDate: new Date("2026-07-31T08:00:00.000Z"),
    repaymentSchedule: [{
      id: "sched-1",
      dueDate: new Date("2026-07-31T08:00:00.000Z"),
      principalDue: 200_000,
      interestDue: 10_000,
      feesDue: 36_900,
      totalDue: 246_900,
      totalPaid: 0,
    }],
  }))

  try {
    const response = await POST(
      makeReq({ type: "payment.completed", data: { id: "stitch-123" } }),
    )
    expect(response.status).toBe(200)
  } finally {
    vi.useRealTimers()
  }

  expect(loanUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      totalInterest: 5_000,
      totalRepayable: 241_900,
      contractualTotalInterest: 10_000,
      contractualTotalRepayable: 246_900,
      status: "COMPLETED",
    }),
  }))
})

it("replays idempotently: no Payment create, no allocation, no audit", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment())
  stitchUpdateManyMock.mockResolvedValue({ count: 0 })

  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

  expect(await res.json()).toEqual({ ok: true, replayed: true })
  expect(paymentCreateMock).not.toHaveBeenCalled()
  expect(loanFindUniqueMock).not.toHaveBeenCalled()
  expect(scheduleUpdateMock).not.toHaveBeenCalled()
  expect(loanUpdateMock).not.toHaveBeenCalled()
  expect(auditCreateMock).not.toHaveBeenCalled()
})

it("takes the tenant from the payment request's loan and runs inside that tenant's context", async () => {
  findUniqueStitchMock.mockResolvedValue(stitchPayment({ loan: { tenantId: "t-from-loan" } }))
  loanFindUniqueMock.mockResolvedValue(makeLoan("ACTIVE"))

  const res = await POST(makeReq({ type: "payment.completed", data: { id: "stitch-123" } }))

  expect(res.status).toBe(200)
  expect(findUniqueStitchMock).toHaveBeenCalledWith(
    expect.objectContaining({ include: { loan: { select: { tenantId: true } } } })
  )
  expect(tenantSeenByLoanReadMock).toHaveBeenCalledWith("t-from-loan")
  expect(paymentCreateMock).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ tenantId: "t-from-loan" }) })
  )
  expect(auditCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({ tenantId: "t-from-loan" }),
  })
})
