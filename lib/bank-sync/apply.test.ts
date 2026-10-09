import { describe, it, expect, vi, beforeEach } from "vitest"

const tx = {
  // #422: the loan is now read + FOR-UPDATE-locked INSIDE the transaction.
  $queryRaw: vi.fn(async () => []),
  $executeRawUnsafe: vi.fn(async () => 1),
  payment: { create: vi.fn(async () => ({ id: "pay1" })), findFirst: vi.fn(async () => null) },
  repaymentSchedule: { update: vi.fn() },
  loan: { findFirst: vi.fn(), update: vi.fn() },
  bankTransaction: { updateMany: vi.fn(async () => ({ count: 1 })), update: vi.fn() },
  auditLog: { create: vi.fn(async () => ({ id: "audit1" })) },
}
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(async (fn) => fn(tx)),
    bankTransaction: { findFirst: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  },
}))
// Schedule dates are re-derived against real Postgres in
// lib/loan/schedule-paid-at.integration.test.ts.
vi.mock("@/lib/loan/schedule-paid-at", () => ({ restampSchedulePaidAt: vi.fn(async () => undefined) }))
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  AuditAction: { BANK_TXN_RECONCILED: "BANK_TXN_RECONCILED", BANK_TXN_IGNORED: "BANK_TXN_IGNORED" },
}))

import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"
import {
  applyBankTransaction,
  ignoreBankTransaction,
  InvalidLoanStateError,
  TransactionNotFoundError,
} from "./apply"

// NOTE: `direction: "CREDIT"` is required here — BankTransaction.direction is a
// non-nullable schema field, and applyBankTransaction guards on it (only credit
// lines can be reconciled into a Payment). The task brief's fixture omitted it;
// added to reflect the real schema shape.
const baseTxn = {
  id: "txn1", tenantId: "t1", amountCents: 150000, rawReference: "LN-0099",
  matchStatus: "PROPOSED", direction: "CREDIT",
  // postedDate is NOT NULL in the schema and now drives interest accrual, so
  // the fixture has to carry it. valueDate is the bank's own value date when
  // supplied; parse.ts emits null today, so postedDate is what is used.
  postedDate: new Date("2026-01-15T00:00:00.000Z"),
  valueDate: null,
}
const baseLoan = {
  id: "loanA", tenantId: "t1", status: "ACTIVE",
  principal: 1_000_000, totalInterest: 200_000, totalRepayable: 1_200_000,
  contractualTotalInterest: null, contractualTotalRepayable: null,
  totalPaid: 0, interestRatePm: 0.05, interestModel: "FLAT",
  startDate: new Date("2026-01-01T00:00:00.000Z"),
  maturityDate: new Date("2026-02-01T00:00:00.000Z"),
  closedAt: null,
  repaymentSchedule: [{
    id: "s1", totalDue: 1_200_000, totalPaid: 0,
    principalDue: 1_000_000, interestDue: 200_000, feesDue: 0,
    dueDate: new Date("2026-02-01T00:00:00.000Z"), status: "PENDING",
  }],
}

beforeEach(() => vi.clearAllMocks())

describe("applyBankTransaction", () => {
  it("creates a Payment, updates the loan, and marks the txn MATCHED", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(baseTxn as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    const res = await applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co" })
    expect(res.paymentId).toBe("pay1")
    // #422: a FOR UPDATE lock is taken on the loan before the balance is read/written.
    expect(tx.$queryRaw).toHaveBeenCalled()
    const lockSql = ((vi.mocked(tx.$queryRaw).mock.calls[0] as unknown[])[0] as string[]).join(" ")
    expect(lockSql).toMatch(/FOR UPDATE/)
    expect(vi.mocked(tx.$queryRaw).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(tx.loan.findFirst).mock.invocationCallOrder[0])
    expect(vi.mocked(tx.$queryRaw).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(tx.loan.update).mock.invocationCallOrder[0])
    expect(tx.bankTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "txn1", tenantId: "t1", matchStatus: { in: ["PROPOSED", "UNMATCHED"] } }),
      data: { matchStatus: "MATCHED" },
    }))
    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ loanId: "loanA", amount: 150000, capturedBy: "absa-sync:u1" }),
    }))
    expect(tx.bankTransaction.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ paymentId: "pay1", matchedLoanId: "loanA", reviewedBy: "u1" }),
    }))
    const updateData = vi.mocked(tx.loan.update).mock.calls[0][0].data
    expect(updateData).not.toHaveProperty("contractualTotalInterest")
    expect(updateData).not.toHaveProperty("contractualTotalRepayable")
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t1",
        userId: "u1",
        userEmail: "u@x.co",
        action: "BANK_TXN_RECONCILED",
        entity: "BankTransaction",
        entityId: "txn1",
        newValue: expect.objectContaining({
          loanId: "loanA",
          amountCents: 150000,
          paymentId: "pay1",
        }),
      }),
    })
    expect(tx.$executeRawUnsafe).toHaveBeenLastCalledWith(
      "SET CONSTRAINTS ALL IMMEDIATE",
    )
  })

  it("splits a deposit that exceeds settlement instead of refusing the import", async () => {
    // The deposit is already in the bank account. Rejecting it left the
    // BankTransaction unmatched and the loan open forever — the same defect the
    // manual capture path had, on the ONE money-import path.
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
      ...baseTxn,
      amountCents: 1_250_000,
      postedDate: new Date("2026-02-01T00:00:00.000Z"),
    } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)

    await applyBankTransaction({
      txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
    })

    // settlementDue = 1_200_000; deposit 1_250_000 → R500.00 refund due.
    expect(tx.payment.create).toHaveBeenCalledTimes(2)
    expect(tx.payment.create).toHaveBeenNthCalledWith(1, expect.objectContaining({
      data: expect.objectContaining({ amount: 1_200_000 }),
    }))
    expect(tx.payment.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        amount: 50_000,
        allocationStatus: "UNAPPLIED",
        reconciliationReason: "overpayment_refund_due",
      }),
    }))
    // The loan's collected total is the allocated portion only — the excess is
    // money held for the client, and Loan.totalPaid must stay equal to the sum
    // of ALLOCATED receipts or the DB allocation assertion fails.
    expect(vi.mocked(tx.loan.update).mock.calls[0][0].data).toMatchObject({
      totalPaid: 1_200_000,
      lastPaymentAmount: 1_200_000,
      status: "COMPLETED",
    })
  })

  it("links the bank transaction to the allocated receipt, not the refund-due one", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
      ...baseTxn,
      amountCents: 1_250_000,
      postedDate: new Date("2026-02-01T00:00:00.000Z"),
    } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    vi.mocked(tx.payment.create)
      .mockResolvedValueOnce({ id: "pay-alloc" } as never)
      .mockResolvedValueOnce({ id: "pay-excess" } as never)

    const res = await applyBankTransaction({
      txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
    })

    expect(res.paymentId).toBe("pay-alloc")
    expect(vi.mocked(tx.bankTransaction.update).mock.calls[0][0].data).toMatchObject({
      paymentId: "pay-alloc",
    })
    expect(tx.payment.create).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({ parentPaymentId: "pay-alloc" }),
    }))
  })

  it("books only accrued interest when a daily-accrual deposit settles on day 15", async () => {
    vi.useFakeTimers()
    // Imported 9 days after the money landed: if accrual used import
    // time the client would be billed for the gap.
    vi.setSystemTime(new Date("2026-07-25T10:00:00.000Z"))
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
      ...baseTxn,
      amountCents: 241_900,
      // Accrual now runs to the BANK's date, so the statement line must be
      // dated day 15 of this loan rather than inheriting the base fixture's.
      postedDate: new Date("2026-07-16T00:00:00.000Z"),
    } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue({
      ...baseLoan,
      principal: 200_000,
      totalInterest: 10_000,
      totalRepayable: 246_900,
      interestModel: "DAILY_ACCRUAL",
      startDate: new Date("2026-07-01T08:00:00.000Z"),
      maturityDate: new Date("2026-07-31T08:00:00.000Z"),
      repaymentSchedule: [{
        id: "s1",
        dueDate: new Date("2026-07-31T08:00:00.000Z"),
        principalDue: 200_000,
        interestDue: 10_000,
        feesDue: 36_900,
        totalDue: 246_900,
        totalPaid: 0,
        status: "PENDING",
      }],
    } as never)

    try {
      await applyBankTransaction({
        txnId: "txn1",
        loanId: "loanA",
        tenantId: "t1",
        userId: "u1",
        userEmail: "u@x.co",
      })
    } finally {
      vi.useRealTimers()
    }

    expect(tx.loan.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        totalInterest: 5_000,
        totalRepayable: 241_900,
        contractualTotalInterest: 10_000,
        contractualTotalRepayable: 246_900,
        status: "COMPLETED",
      }),
    }))
  })



  it("rejects a loan that is not ACTIVE/DEFAULTED", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(baseTxn as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue({ ...baseLoan, status: "COMPLETED" } as never)
    await expect(applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co" }))
      .rejects.toBeInstanceOf(InvalidLoanStateError)
    expect(tx.payment.create).not.toHaveBeenCalled()
  })

  it("rejects an already-MATCHED txn", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({ ...baseTxn, matchStatus: "MATCHED" } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    await expect(applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co" }))
      .rejects.toBeInstanceOf(InvalidLoanStateError)
    expect(tx.payment.create).not.toHaveBeenCalled()
  })

  it("rejects an already-IGNORED txn (a human excluded this deposit)", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({ ...baseTxn, matchStatus: "IGNORED" } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    await expect(applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co" }))
      .rejects.toBeInstanceOf(InvalidLoanStateError)
    expect(tx.payment.create).not.toHaveBeenCalled()
  })

  it("rejects a non-CREDIT txn", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({ ...baseTxn, direction: "DEBIT" } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    await expect(applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co" }))
      .rejects.toBeInstanceOf(InvalidLoanStateError)
    expect(tx.payment.create).not.toHaveBeenCalled()
  })

  it("rejects a concurrent double-confirm losing the atomic claim (no duplicate Payment)", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(baseTxn as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    vi.mocked(tx.bankTransaction.updateMany).mockResolvedValueOnce({ count: 0 } as never)
    await expect(applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co" }))
      .rejects.toBeInstanceOf(InvalidLoanStateError)
    expect(tx.payment.create).not.toHaveBeenCalled()
  })

  it("applies a system (no-userId) reconciliation with an unsuffixed capturedBy", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(baseTxn as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)
    const res = await applyBankTransaction({ txnId: "txn1", loanId: "loanA", tenantId: "t1", userEmail: "system@bank-sync" })
    expect(res.paymentId).toBe("pay1")
    expect(tx.payment.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ capturedBy: "absa-sync" }),
    }))
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: null,
        userEmail: "system@bank-sync",
        action: "BANK_TXN_RECONCILED",
      }),
    })
  })
})

describe("ignoreBankTransaction", () => {
  it("atomically marks a PROPOSED/UNMATCHED txn IGNORED with a reason and logs the audit action", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(baseTxn as never)
    vi.mocked(prisma.bankTransaction.updateMany).mockResolvedValue({ count: 1 } as never)
    await ignoreBankTransaction({ txnId: "txn1", tenantId: "t1", userId: "u1", userEmail: "u@x.co", reason: "duplicate deposit" })
    expect(prisma.bankTransaction.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: "txn1", tenantId: "t1", matchStatus: { in: ["PROPOSED", "UNMATCHED"] } }),
      data: expect.objectContaining({ matchStatus: "IGNORED", ignoreReason: "duplicate deposit", reviewedBy: "u1" }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      userEmail: "u@x.co",
      action: "BANK_TXN_IGNORED",
      entity: "BankTransaction",
      entityId: "txn1",
      newValue: { reason: "duplicate deposit" },
    }))
  })

  it("rejects a missing/wrong-tenant txn without logging or updating", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(null as never)
    await expect(ignoreBankTransaction({ txnId: "txn1", tenantId: "t1", userId: "u1", userEmail: "u@x.co", reason: "duplicate deposit" }))
      .rejects.toBeInstanceOf(TransactionNotFoundError)
    expect(logAudit).not.toHaveBeenCalled()
    expect(prisma.bankTransaction.updateMany).not.toHaveBeenCalled()
  })

  it("rejects (no audit) when the txn was concurrently matched/ignored — atomic claim count 0", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue(baseTxn as never)
    vi.mocked(prisma.bankTransaction.updateMany).mockResolvedValue({ count: 0 } as never)
    await expect(ignoreBankTransaction({ txnId: "txn1", tenantId: "t1", userId: "u1", userEmail: "u@x.co", reason: "duplicate deposit" }))
      .rejects.toBeInstanceOf(InvalidLoanStateError)
    expect(logAudit).not.toHaveBeenCalled()
  })
})

describe("applyBankTransaction — bank-attested value date", () => {
  // The bank's date is a third party attesting when money moved, so there is no
  // recency window — a month-old statement line must still import. The
  // impossible bounds still hold.
  it("imports a month-old statement line with no override", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-01T10:00:00.000Z"))
    try {
      vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
        ...baseTxn, postedDate: new Date("2026-01-20T00:00:00.000Z"),
      } as never)
      vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)

      await applyBankTransaction({
        txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
      })
      expect(tx.payment.create).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  // elapsedContractDays clamps at 0, so a line dated before disbursement would
  // settle the loan for principal and fees and write off all earned interest.
  it("refuses a deposit dated before the loan was disbursed", async () => {
    vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
      ...baseTxn, postedDate: new Date("2025-12-01T00:00:00.000Z"),
    } as never)
    vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)

    await expect(applyBankTransaction({
      txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
    })).rejects.toBeInstanceOf(InvalidLoanStateError)

    // Nothing booked, and the txn is NOT claimed — it stays PROPOSED for a human.
    expect(tx.payment.create).not.toHaveBeenCalled()
    expect(tx.loan.update).not.toHaveBeenCalled()
    expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled()
  })

  it("prefers the bank's valueDate over its postedDate", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-02-10T10:00:00.000Z"))
    try {
      vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
        ...baseTxn,
        valueDate: new Date("2026-01-18T00:00:00.000Z"),
        postedDate: new Date("2026-01-20T00:00:00.000Z"),
      } as never)
      vi.mocked(tx.loan.findFirst).mockResolvedValue(baseLoan as never)

      await applyBankTransaction({
        txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
      })
      const created = (vi.mocked(tx.payment.create).mock.calls as unknown as Array<[{ data: Record<string, unknown> }]>)[0][0].data
      expect(created).toMatchObject({
        receivedAt: new Date("2026-01-18T00:00:00.000Z"),
      })
    } finally { vi.useRealTimers() }
  })
})

describe("applyBankTransaction — unauthorised interest write-off", () => {
  // The CSV is uploaded by a CREDIT_OFFICER and parse.ts bounds its dates not at
  // all, so a typed line dated at disbursement zeroes the interest. Auto-apply
  // has no human to authorise that, so the row must stay PROPOSED rather than
  // book itself.
  it("refuses a statement line that erases the interest, leaving it PROPOSED", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-31T10:00:00.000Z"))
    try {
      vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
        ...baseTxn, amountCents: 241_900,
        postedDate: new Date("2026-07-01T08:00:00.000Z"),
      } as never)
      vi.mocked(tx.loan.findFirst).mockResolvedValue({
        ...baseLoan,
        principal: 200_000, totalInterest: 10_000, totalRepayable: 246_900,
        interestModel: "DAILY_ACCRUAL",
        startDate: new Date("2026-07-01T08:00:00.000Z"),
        maturityDate: new Date("2026-07-31T08:00:00.000Z"),
        repaymentSchedule: [{
          id: "s1", dueDate: new Date("2026-07-31T08:00:00.000Z"),
          principalDue: 200_000, interestDue: 10_000, feesDue: 36_900,
          totalDue: 246_900, totalPaid: 0,
        }],
      } as never)

      await expect(applyBankTransaction({
        txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
      })).rejects.toBeInstanceOf(InvalidLoanStateError)

      expect(tx.payment.create).not.toHaveBeenCalled()
      expect(tx.loan.update).not.toHaveBeenCalled()
      // Not claimed, so a human still sees it on the reconcile screen.
      expect(tx.bankTransaction.updateMany).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  // An ordinary import lag must still flow through untouched.
  it("still applies a normal few-day import lag", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-07-20T10:00:00.000Z"))
    try {
      vi.mocked(prisma.bankTransaction.findFirst).mockResolvedValue({
        ...baseTxn, postedDate: new Date("2026-07-17T00:00:00.000Z"),
      } as never)
      vi.mocked(tx.loan.findFirst).mockResolvedValue({
        ...baseLoan, interestModel: "DAILY_ACCRUAL",
        startDate: new Date("2026-07-01T08:00:00.000Z"),
        maturityDate: new Date("2026-07-31T08:00:00.000Z"),
      } as never)

      await applyBankTransaction({
        txnId: "txn1", loanId: "loanA", tenantId: "t1", userId: "u1", userEmail: "u@x.co",
      })
      expect(tx.payment.create).toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })
})
