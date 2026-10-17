import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import { NextRequest } from "next/server"

const {
  requireApiRole,
  findUnique,
  paymentUpdate,
  paymentUpdateMany,
  auditCreate,
  logAudit,
  lockLoanForUpdate,
  recoveryCount,
  saleCount,
} = vi.hoisted(() => ({
  requireApiRole: vi.fn(),
  findUnique: vi.fn(),
  paymentUpdate: vi.fn(),
  paymentUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  logAudit: vi.fn(),
  lockLoanForUpdate: vi.fn(),
  recoveryCount: vi.fn(),
  saleCount: vi.fn(),
}))

let committedReversed = false
let committedReason: string | null = null
let auditFailure = false
let transactionQueue: Promise<unknown> = Promise.resolve()

const payment = {
  id: "payment-1",
  tenantId: "tenant-1",
  loanId: "loan-1",
  amount: 100_000,
  reversed: false,
  allocationStatus: "ALLOCATED",
}
const schedule = [{
  id: "schedule-1",
  dueDate: new Date("2026-08-01T00:00:00.000Z"),
  principalDue: 100_000,
  interestDue: 5_000,
  feesDue: 6_900,
  totalDue: 111_900,
  totalPaid: 100_000,
  status: "PARTIAL",
  paidAt: null,
}]
const loan = {
  id: "loan-1",
  tenantId: "tenant-1",
  principal: 100_000,
  totalInterest: 5_000,
  totalRepayable: 111_900,
  contractualTotalInterest: 5_000,
  contractualTotalRepayable: 111_900,
  totalPaid: 100_000,
  interestRatePm: 0.05,
  interestModel: "DAILY_ACCRUAL",
  startDate: new Date("2026-07-01T00:00:00.000Z"),
  maturityDate: new Date("2026-08-01T00:00:00.000Z"),
  status: "ACTIVE",
  closedAt: null,
  repaymentSchedule: schedule,
}

function transaction(callback: (tx: unknown) => Promise<unknown>) {
  const run = transactionQueue.then(async () => {
    let txReversed = committedReversed
    // A real sibling set the mocks FILTER, rather than two constants that the
    // assertions then re-state. Returning a hardcoded count made
    // `reversedExcessReceipts: 1` an assertion derived from the same source as
    // the value it checked — it could not fail.
    // TWO unapplied siblings, deliberately: with one, `reversedExcessReceipts:
    // reversedExcess.count` and a hardcoded `1` are indistinguishable, so the
    // assertion still could not fail.
    const siblings = [
      { id: "excess-1", reversed: false, allocationStatus: "UNAPPLIED" },
      { id: "excess-2", reversed: false, allocationStatus: "UNAPPLIED" },
      { id: "excess-3", reversed: false, allocationStatus: "REFUNDED" },
    ]
    let txReason = committedReason
    const tx = {
      payment: {
        update: async (args: {
          data: { reversalReason: string }
        }) => {
          paymentUpdate(args)
          txReversed = true
          txReason = args.data.reversalReason
          return { ...payment, reversed: true }
        },
        // The parent claim and the refund-due cascade both come through here.
        // Sharing one stateful flag made the SECOND call always return count 0,
        // so the cascade was a guaranteed no-op and its where-clause could not
        // be observed. They are told apart by their where shape instead.
        updateMany: async (args: {
          where: Record<string, unknown>
          data: { reversalReason: string }
        }) => {
          paymentUpdateMany(args)
          if (args.where.parentPaymentId !== undefined) {
            const matched = siblings.filter((sib) =>
              sib.reversed === args.where.reversed
              && sib.allocationStatus === args.where.allocationStatus)
            matched.forEach((sib) => { sib.reversed = true })
            return { count: matched.length }
          }
          if (txReversed) return { count: 0 }
          txReversed = true
          txReason = args.data.reversalReason
          return { count: 1 }
        },
        aggregate: async () => ({ _sum: { amount: 0 } }),
        findFirst: async () => null,
        // Siblings already paid out to the client; counted, never reversed.
        count: async (args: { where: Record<string, unknown> }) =>
          siblings.filter((sib) =>
            sib.reversed === args.where.reversed
            && sib.allocationStatus === args.where.allocationStatus).length,
      },
      recovery: { count: recoveryCount },
      remarketingSale: { count: saleCount },
      loan: {
        findUniqueOrThrow: async () => loan,
        update: async () => loan,
      },
      repaymentSchedule: {
        update: async () => schedule[0],
      },
      auditLog: {
        create: async (args: unknown) => {
          auditCreate(args)
          if (auditFailure) throw new Error("audit unavailable")
          return { id: "audit-1" }
        },
      },
    }
    const result = await callback(tx)
    committedReversed = txReversed
    committedReason = txReason
    return result
  })
  transactionQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
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
    payment: { findUnique },
    $transaction: transaction,
  },
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: {
    PAYMENT_REVERSED: "PAYMENT_REVERSED",
    LOAN_STATUS_CHANGED: "LOAN_STATUS_CHANGED",
  },
  logAudit,
}))
vi.mock("@/lib/loan/lock", () => ({ lockLoanForUpdate }))
vi.mock("@/lib/loan/balances", () => ({
  allocateReceipts: () => [0],
  recomputeLoanBalances: () => ({
    outstandingPrincipal: 100_000,
    arrearsAmount: 0,
    daysInArrears: 0,
  }),
  nextPaymentDueDate: () => schedule[0].dueDate,
}))
// Schedule dates are re-derived against real Postgres in
// lib/loan/schedule-paid-at.integration.test.ts.
vi.mock("@/lib/loan/schedule-paid-at", () => ({ restampSchedulePaidAt: vi.fn(async () => undefined) }))
// The contractual-schedule restore is proven against real Postgres in
// lib/loan/s125-settlement.integration.test.ts.
vi.mock("@/lib/loan/contractual-schedule", () => ({
  contractualScheduleOf: async () => schedule,
  ContractualScheduleError: class extends Error {},
}))

import { PATCH } from "./route"

const context = { params: Promise.resolve({ id: "payment-1" }) }

function request(reason: string) {
  return new NextRequest("http://localhost/api/payments/payment-1/reverse", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason }),
  })
}

describe("PATCH /api/payments/[id]/reverse", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    committedReversed = false
    committedReason = null
    auditFailure = false
    transactionQueue = Promise.resolve()
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    // Both concurrent requests may read this pre-transaction projection before
    // either transaction commits. The authoritative claim belongs inside tx.
    findUnique.mockResolvedValue(payment)
    recoveryCount.mockResolvedValue(0)
    saleCount.mockResolvedValue(0)
    logAudit.mockResolvedValue(undefined)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  it.each([["a recovery", 1, 0], ["a remarketing sale", 0, 1]])("refuses to reverse the receipt that is %s's sale proceeds, writing nothing", async (_name, recoveries, sales) => {
    recoveryCount.mockResolvedValue(recoveries)
    saleCount.mockResolvedValue(sales)

    const response = await PATCH(request("Bank returned the deposit"), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe("This receipt is a recovery's sale proceeds and cannot be reversed")
    expect(recoveryCount).toHaveBeenCalledWith({ where: { tenantId: "tenant-1", proceedsPaymentId: "payment-1" } })
    // Checked after the loan lock, inside the transaction, and the rolled-back transaction wrote nothing.
    expect(lockLoanForUpdate).toHaveBeenCalledOnce()
    expect(lockLoanForUpdate.mock.invocationCallOrder[0]).toBeLessThan(recoveryCount.mock.invocationCallOrder[0])
    expect(paymentUpdateMany).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
    expect(committedReversed).toBe(false)
  })

  it("answers 409, not 500, when the database refuses the reversal because a recovery took the receipt meanwhile", async () => {
    lockLoanForUpdate.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError(
      "\nInvalid `tx.payment.updateMany()` invocation:\n\nRaw query failed. Code: `23514`. Message: `ERROR: A recovery's sale-proceeds receipt is not reversed`",
      { code: "P2010", clientVersion: "test", meta: { code: "23514" } },
    ))

    const response = await PATCH(request("Bank returned the deposit"), context)

    expect(response.status).toBe(409)
    expect((await response.json()).error).toBe("This receipt is a recovery's sale proceeds and cannot be reversed")
  })

  it("lets only one concurrent reversal claim the payment and preserves its reason", async () => {
    const responses = await Promise.all([
      PATCH(request("First bank-return reason"), context),
      PATCH(request("Second duplicate reason"), context),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
    expect(committedReversed).toBe(true)
    expect(committedReason).toBe("First bank-return reason")
    // Each request attempts the claim exactly once; only the winner goes on to
    // cascade the reversal to any refund-due sibling. Counted by shape rather
    // than by total calls, so the guarantee survives new writes being added.
    const claims = paymentUpdateMany.mock.calls
      .filter((call) => call[0]?.where?.allocationStatus === "ALLOCATED")
    const cascades = paymentUpdateMany.mock.calls
      .filter((call) => call[0]?.where?.parentPaymentId !== undefined)
    expect(claims).toHaveLength(2)
    expect(cascades).toHaveLength(1)
    expect(auditCreate).toHaveBeenCalledOnce()
  })

  it("retires the refund-due sibling when an over-payment's parent is reversed", async () => {
    // A split over-payment leaves an UNAPPLIED row asserting the client is owed
    // money back. If the parent is reversed (a bounced EFT), that claim is for
    // money never received — leaving it live invites staff to pay out a refund
    // on a deposit that no longer exists.
    const response = await PATCH(request("Bank returned the debit"), context)

    expect(response.status).toBe(200)
    const cascade = paymentUpdateMany.mock.calls
      .find((call) => call[0]?.where?.parentPaymentId !== undefined)
    expect(cascade).toBeDefined()
    expect(cascade![0].where).toMatchObject({
      parentPaymentId: "payment-1",
      tenantId: "tenant-1",
      reversed: false,
      // Load-bearing: a sibling already flipped to REFUNDED is cash the lender
      // has actually paid out. Reversing it would leave neither a receipt nor a
      // refund in the ledger. Omitting this clause was the mutation that
      // previously left the whole suite green.
      allocationStatus: "UNAPPLIED",
    })
    expect(cascade![0].data).toMatchObject({ reversed: true })
    expect(cascade![0].data.reversalReason).toMatch(/Parent receipt reversed/)
    // Recorded on the same audit entry, so the retirement is not invisible.
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        // Not expect.any(Number): 0 satisfied that, so a cascade which retired
        // nothing was indistinguishable from one that worked.
        // One UNAPPLIED sibling retired; the REFUNDED one is cash already paid
        // out, so it must be counted as a recovery obligation, not reversed.
        newValue: expect.objectContaining({
          reversedExcessReceipts: 2,
          refundsAlreadyPaidOut: 1,
        }),
      }),
    }))
  })

  it("rolls back the reversal and balance mutation when mandatory audit evidence fails", async () => {
    auditFailure = true

    const response = await PATCH(request("Bank returned the debit"), context)

    expect(response.status).toBe(500)
    expect(committedReversed).toBe(false)
    expect(committedReason).toBeNull()
    expect(auditCreate).toHaveBeenCalledOnce()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("refuses to reverse held money that must use receipt reconciliation", async () => {
    findUnique.mockResolvedValue({
      ...payment,
      allocationStatus: "UNAPPLIED",
    })

    const response = await PATCH(
      request("This must not bypass reconciliation"),
      context,
    )

    expect(response.status).toBe(409)
    expect(paymentUpdateMany).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })
})
