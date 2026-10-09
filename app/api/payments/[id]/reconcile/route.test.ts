import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  candidateFindUnique,
  paymentUpdateMany,
  scheduleUpdate,
  loanUpdate,
  auditCreate,
  executeRawUnsafe,
  lockLoanForUpdate,
  triggerNotification,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  candidateFindUnique: vi.fn(),
  paymentUpdateMany: vi.fn(),
  scheduleUpdate: vi.fn(),
  loanUpdate: vi.fn(),
  auditCreate: vi.fn(),
  executeRawUnsafe: vi.fn(),
  lockLoanForUpdate: vi.fn(),
  triggerNotification: vi.fn(),
}))

const createdAt = new Date("2026-07-24T10:00:00.000Z")
// The value date: when the money actually arrived, which is what the receipt is
// priced at. Earlier than createdAt because this screen exists for receipts
// that sat unallocated.
const receivedAt = new Date("2026-07-14T10:00:00.000Z")
const baseSchedule = [{
  id: "schedule-1",
  dueDate: new Date("2026-08-24T00:00:00.000Z"),
  principalDue: 480_000,
  interestDue: 13_100,
  feesDue: 6_900,
  totalDue: 500_000,
  totalPaid: 100_000,
  status: "PARTIAL",
  paidAt: null,
}]
const baseLoan = {
  id: "loan-1",
  tenantId: "tenant-1",
  principal: 480_000,
  totalInterest: 13_100,
  totalRepayable: 500_000,
  contractualTotalInterest: 13_100,
  contractualTotalRepayable: 500_000,
  totalPaid: 100_000,
  outstandingPrincipal: 386_900,
  interestRatePm: 0.05,
  interestModel: "FLAT",
  startDate: new Date("2026-07-04T00:00:00.000Z"),
  maturityDate: new Date("2026-08-24T00:00:00.000Z"),
  status: "ACTIVE",
  closedAt: null,
  repaymentSchedule: baseSchedule,
}

let committedAllocationStatus = "UNAPPLIED"
let committedLoanTotalPaid = 100_000
let receiptAmount = 50_000
let auditFailure = false
// FLAT is not re-priced by date, so the FLAT fixture cannot observe which date
// the receipt is priced at. Only DAILY_ACCRUAL can.
let loanInterestModel = "FLAT"
// Per-test so a case can back-date to disbursement, where the rebate stops
// being an ordinary capture lag and erases the whole interest charge.
let paymentReceivedAt = receivedAt

function currentPayment(status = committedAllocationStatus) {
  return {
    id: "payment-1",
    tenantId: "tenant-1",
    loanId: "loan-1",
    amount: receiptAmount,
    createdAt,
    receivedAt: paymentReceivedAt,
    reversed: false,
    allocationStatus: status,
    reconciliationReason: "amount_exceeds_current_settlement",
    reconciliationReference: null,
  }
}

async function transaction(callback: (tx: unknown) => Promise<unknown>) {
  let txStatus = committedAllocationStatus
  let txLoanTotalPaid = committedLoanTotalPaid
  const tx = {
    $executeRawUnsafe: vi.fn(async (statement: string) => {
      executeRawUnsafe(statement)
      return 1
    }),
    payment: {
      findUnique: vi.fn(async () => currentPayment(txStatus)),
      updateMany: vi.fn(async (args: {
        where: { allocationStatus: string; reversed: boolean }
        data: { allocationStatus: string }
      }) => {
        paymentUpdateMany(args)
        if (
          txStatus !== args.where.allocationStatus
          || args.where.reversed !== false
        ) return { count: 0 }
        txStatus = args.data.allocationStatus
        return { count: 1 }
      }),
      findFirst: vi.fn(async () => ({
        amount: receiptAmount,
        createdAt,
      })),
    },
    loan: {
      findUnique: vi.fn(async () => ({
        ...baseLoan,
        interestModel: loanInterestModel,
        totalPaid: txLoanTotalPaid,
        repaymentSchedule: baseSchedule.map((row) => ({
          ...row,
          totalPaid: txLoanTotalPaid,
        })),
      })),
      update: vi.fn(async (args: { data: { totalPaid: number } }) => {
        loanUpdate(args)
        txLoanTotalPaid = args.data.totalPaid
        return { ...baseLoan, totalPaid: txLoanTotalPaid }
      }),
    },
    repaymentSchedule: {
      update: vi.fn(async (args: unknown) => {
        scheduleUpdate(args)
        return baseSchedule[0]
      }),
    },
    auditLog: {
      create: vi.fn(async (args: unknown) => {
        auditCreate(args)
        if (auditFailure) throw new Error("audit unavailable")
        return { id: "audit-1" }
      }),
    },
  }

  const result = await callback(tx)
  committedAllocationStatus = txStatus
  committedLoanTotalPaid = txLoanTotalPaid
  return result
}

vi.mock("@/lib/auth-guards", () => ({ requireApiRole }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    callback: (tenant: { id: string }) => unknown,
  ) => callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    payment: { findUnique: candidateFindUnique },
    $transaction: transaction,
  },
}))
vi.mock("@/lib/loan/lock", () => ({ lockLoanForUpdate }))
// Schedule dates are re-derived against real Postgres in
// lib/loan/schedule-paid-at.integration.test.ts.
vi.mock("@/lib/loan/schedule-paid-at", () => ({ restampSchedulePaidAt: vi.fn(async () => undefined) }))
vi.mock("@/lib/notifications", () => ({ triggerNotification }))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    PAYMENT_ALLOCATED: "PAYMENT_ALLOCATED",
    PAYMENT_REFUND_RECORDED: "PAYMENT_REFUND_RECORDED",
    LOAN_STATUS_CHANGED: "LOAN_STATUS_CHANGED",
  },
}))

import { PATCH } from "./route"

const context = { params: Promise.resolve({ id: "payment-1" }) }

function request(
  action: "allocate" | "record_refund",
  overrides: Record<string, unknown> = {},
) {
  return new NextRequest("http://localhost/api/payments/payment-1/reconcile", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action,
      reason: "Matched bank settlement",
      reference: "BANK-REF-123",
      ...overrides,
    }),
  })
}

describe("PATCH /api/payments/[id]/reconcile", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    committedAllocationStatus = "UNAPPLIED"
    committedLoanTotalPaid = 100_000
    receiptAmount = 50_000
    auditFailure = false
    loanInterestModel = "FLAT"
    paymentReceivedAt = receivedAt
    candidateFindUnique.mockResolvedValue({ id: "payment-1", loanId: "loan-1" })
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    triggerNotification.mockResolvedValue(undefined)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("prices a delayed receipt at the date the money arrived, not the date it was reconciled", async () => {
    // The money landed on 14 July; staff reconciled it on 24 July. s125(2)(b)
    // charges interest only to the settlement date, so the 10-day desk delay is
    // not the consumer's to pay. Time is frozen at the reconciliation date so
    // the two dates stay 10 days apart no matter when this suite runs.
    loanInterestModel = "DAILY_ACCRUAL"
    receiptAmount = 394_900
    vi.useFakeTimers()
    vi.setSystemTime(createdAt)

    const response = await PATCH(request("allocate"), context)

    // R480 000 at 5%/month accrues R8,00 a day: R80,00 over the 10 days to the
    // value date, against the full contractual R131,00 by the reconciliation
    // date. Priced at reconcile time the settlement due would be R4 000,00 and
    // this R3 949,00 receipt would leave the loan ACTIVE and R51,00 short —
    // billing the client for the delay and refusing to close a settled loan.
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(expect.objectContaining({
      loanStatus: "COMPLETED",
    }))
    expect(loanUpdate.mock.calls[0][0].data).toEqual(expect.objectContaining({
      totalInterest: 8_000,
      totalRepayable: 494_900,
      closedAt: receivedAt,
    }))
    expect(scheduleUpdate.mock.calls[0][0].data).toEqual(expect.objectContaining({
      interestDue: 8_000,
      paidAt: receivedAt,
    }))
    // The rebate this back-date created must be on the audit row, in the same
    // shape the other two writers record.
    const allocated = auditCreate.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.action === "PAYMENT_ALLOCATED")
    expect(allocated.newValue).toEqual(expect.objectContaining({
      receivedAt: receivedAt.toISOString(),
      daysBackdated: 10,
      interestRebateCents: 5_100,
      // NOT "STAFF_ASSERTED": this admin did not choose the date, and claiming
      // they did contradicts the bank-sync audit row for the same receipt.
      source: "UNKNOWN_INHERITED",
    }))
  })

  it("rejects a non-text override reason with 400 rather than throwing", async () => {
    const response = await PATCH(
      request("allocate", { valueDateOverrideReason: 12_345 }),
      context,
    )

    expect(response.status).toBe(400)
    expect(committedAllocationStatus).toBe("UNAPPLIED")
  })

  it("refuses to allocate a rebate above the unreviewed limit without a reason", async () => {
    // Dated at disbursement, so the loan prices as if no time had passed: the
    // whole R131,00 of accrued interest is written off. That breaches both
    // clauses — over the R100,00 unreviewed cap AND erasing 100% of interest
    // earned to date. A 10-day lag (the test above) is R51,00 and stays
    // unreviewed, which is the point: ordinary lateness is not an exception.
    loanInterestModel = "DAILY_ACCRUAL"
    paymentReceivedAt = baseLoan.startDate
    receiptAmount = 386_900
    vi.useFakeTimers()
    vi.setSystemTime(createdAt)

    const response = await PATCH(request("allocate"), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      requiresValueDateOverride: true,
    }))
    // Refused BEFORE any write — an unauthorised rebate leaves no receipt.
    expect(committedAllocationStatus).toBe("UNAPPLIED")
    expect(committedLoanTotalPaid).toBe(100_000)
    expect(loanUpdate).not.toHaveBeenCalled()
  })

  it("allocates the same rebate once a loan administrator records a reason", async () => {
    loanInterestModel = "DAILY_ACCRUAL"
    paymentReceivedAt = baseLoan.startDate
    receiptAmount = 386_900
    vi.useFakeTimers()
    vi.setSystemTime(createdAt)

    const response = await PATCH(
      request("allocate", {
        valueDateOverrideReason:
          "Branch cash banked 14 July, receipt located in the safe on the 24th",
      }),
      context,
    )

    expect(response.status).toBe(200)
    expect(committedAllocationStatus).toBe("ALLOCATED")
    const allocated = auditCreate.mock.calls
      .map((c) => c[0].data)
      .find((d) => d.action === "PAYMENT_ALLOCATED")
    expect(allocated.newValue.override).toEqual({
      reason:
        "Branch cash banked 14 July, receipt located in the safe on the 24th",
      approvedById: "admin-1",
      approvedByEmail: "admin@example.test",
    })
  })

  it("allocates held money and updates loan balances with audit evidence atomically", async () => {
    const response = await PATCH(request("allocate"), context)

    expect(response.status).toBe(200)
    expect(committedAllocationStatus).toBe("ALLOCATED")
    expect(committedLoanTotalPaid).toBe(150_000)
    expect(lockLoanForUpdate).toHaveBeenCalledWith(expect.anything(), "loan-1")
    expect(paymentUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        allocationStatus: "UNAPPLIED",
        reversed: false,
      }),
      data: expect.objectContaining({
        allocationStatus: "ALLOCATED",
        reconciliationReference: "BANK-REF-123",
      }),
    }))
    expect(scheduleUpdate).toHaveBeenCalled()
    expect(loanUpdate).toHaveBeenCalled()
    const updateData = loanUpdate.mock.calls[0][0].data
    expect(updateData).not.toHaveProperty("contractualTotalInterest")
    expect(updateData).not.toHaveProperty("contractualTotalRepayable")
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PAYMENT_ALLOCATED",
        entity: "Payment",
        entityId: "payment-1",
      }),
    })
    expect(executeRawUnsafe).toHaveBeenLastCalledWith(
      "SET CONSTRAINTS ALL IMMEDIATE",
    )
    expect(triggerNotification).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      event: "payment_received",
      loanId: "loan-1",
      data: {
        amount: 50_000,
        paymentId: "payment-1",
        allocationStatus: "ALLOCATED",
      },
    })
  })

  it("records an externally completed refund without changing the loan", async () => {
    const response = await PATCH(request("record_refund"), context)

    expect(response.status).toBe(200)
    expect(committedAllocationStatus).toBe("REFUNDED")
    expect(committedLoanTotalPaid).toBe(100_000)
    expect(scheduleUpdate).not.toHaveBeenCalled()
    expect(loanUpdate).not.toHaveBeenCalled()
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PAYMENT_REFUND_RECORDED",
        newValue: expect.objectContaining({
          externalRefundReference: "BANK-REF-123",
          initiatesMoneyMovement: false,
        }),
      }),
    })
    expect(triggerNotification).not.toHaveBeenCalled()
  })

  it("leaves an over-settlement receipt unapplied and returns the current maximum", async () => {
    receiptAmount = 400_001

    const response = await PATCH(request("allocate"), context)

    expect(response.status).toBe(422)
    expect(await response.json()).toEqual(expect.objectContaining({
      maxAmountCents: 400_000,
    }))
    expect(committedAllocationStatus).toBe("UNAPPLIED")
    expect(committedLoanTotalPaid).toBe(100_000)
    expect(paymentUpdateMany).not.toHaveBeenCalled()
  })

  it("rejects replay once another staff action has reconciled the receipt", async () => {
    committedAllocationStatus = "REFUNDED"

    const response = await PATCH(request("allocate"), context)

    expect(response.status).toBe(409)
    expect(committedAllocationStatus).toBe("REFUNDED")
    expect(loanUpdate).not.toHaveBeenCalled()
  })

  it("rolls back allocation and balance changes when mandatory audit evidence fails", async () => {
    auditFailure = true

    const response = await PATCH(request("allocate"), context)

    expect(response.status).toBe(500)
    expect(committedAllocationStatus).toBe("UNAPPLIED")
    expect(committedLoanTotalPaid).toBe(100_000)
    expect(auditCreate).toHaveBeenCalled()
    expect(triggerNotification).not.toHaveBeenCalled()
  })
})
