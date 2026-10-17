import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { applyManualReceipt } from "./apply-payment"

// Schedule dates are re-derived against real Postgres in
// lib/loan/schedule-paid-at.integration.test.ts.
vi.mock("@/lib/loan/schedule-paid-at", () => ({ restampSchedulePaidAt: vi.fn(async () => undefined) }))

interface LoanRow {
  id: string
  status: string
  principal: number
  totalInterest: number
  totalPaid: number
  totalRepayable: number
  contractualTotalInterest: number | null
  contractualTotalRepayable: number | null
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  startDate: Date
  maturityDate: Date
  closedAt: Date | null
  repaymentSchedule: Array<{
    id: string
    dueDate: Date
    principalDue: number
    interestDue: number
    feesDue: number
    totalDue: number
    totalPaid: number
  }>
}

function makeLoan(status: string, over: Partial<LoanRow> = {}): LoanRow {
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
      { id: "sched-1", dueDate: new Date("2026-01-01"), principalDue: 150_000, interestDue: 40_000, feesDue: 10_000, totalDue: 200_000, totalPaid: 100_000 },
      { id: "sched-2", dueDate: new Date("2026-02-01"), principalDue: 300_000, interestDue: 80_000, feesDue: 20_000, totalDue: 400_000, totalPaid: 0 },
    ],
    ...over,
  }
}


function makeDb(
  loan: LoanRow | null,
  existingPayment: Record<string, unknown> | null = null,
) {
  const queryRaw = vi.fn().mockResolvedValue([])
  const executeRaw = vi.fn().mockResolvedValue(1)
  const findUnique = vi.fn().mockResolvedValue(loan)
  const paymentFindUnique = vi.fn().mockResolvedValue(existingPayment)
  const paymentCreate = vi.fn().mockImplementation((a: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: "pay-1", ...a.data }),
  )
  // The latest live receipt on the loan (closingValueDate).
  const paymentFindFirst = vi.fn().mockResolvedValue(null)
  const scheduleUpdate = vi.fn().mockResolvedValue({})
  const loanUpdate = vi.fn().mockResolvedValue({})
  const auditCreate = vi.fn().mockResolvedValue({ id: "audit-1" })
  const tx = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    $executeRawUnsafe: executeRaw,
    loan: { findUnique, update: loanUpdate },
    payment: { findUnique: paymentFindUnique, findFirst: paymentFindFirst, create: paymentCreate },
    repaymentSchedule: { update: scheduleUpdate },
    auditLog: { create: auditCreate },
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = { $transaction: async (cb: (t: any) => Promise<unknown>) => cb(tx) }
  return { db, queryRaw, executeRaw, findUnique, paymentFindUnique, paymentFindFirst, paymentCreate, scheduleUpdate, loanUpdate, auditCreate }
}

const input = { loanId: "loan-1", tenantId: "t1", amount: 50_000, capturedById: "agent-1" }

describe("applyManualReceipt — #422 concurrency guard", () => {
  it("takes a FOR UPDATE lock on the loan BEFORE any read or write", async () => {
    const { db, queryRaw, findUnique, paymentCreate, scheduleUpdate, loanUpdate } = makeDb(makeLoan("ACTIVE"))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, input)

    // The lock statement is a FOR UPDATE on the Loan row...
    expect(queryRaw).toHaveBeenCalledTimes(1)
    const strings = (queryRaw.mock.calls[0][0] as string[]).join(" ")
    expect(strings).toMatch(/FOR UPDATE/)
    expect(strings).toMatch(/"Loan"/)
    // ...and it runs BEFORE the read and every write, or the lock is useless.
    const lockOrder = queryRaw.mock.invocationCallOrder[0]
    expect(lockOrder).toBeLessThan(findUnique.mock.invocationCallOrder[0])
    expect(lockOrder).toBeLessThan(paymentCreate.mock.invocationCallOrder[0])
    expect(lockOrder).toBeLessThan(scheduleUpdate.mock.invocationCallOrder[0])
    expect(lockOrder).toBeLessThan(loanUpdate.mock.invocationCallOrder[0])
  })
})

describe("applyManualReceipt — balance + status behaviour", () => {
  it("captures a partial payment on a DEFAULTED loan and preserves its status", async () => {
    const { db, paymentCreate, loanUpdate } = makeDb(makeLoan("DEFAULTED"))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyManualReceipt(db as any, input)

    expect(result).toMatchObject({
      payment: { loanId: "loan-1", amount: 50_000 },
      idempotentReplay: false,
    })
    expect(paymentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ loanId: "loan-1", amount: 50_000 }) }),
    )
    expect(loanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "DEFAULTED" }) }),
    )
    const updateData = loanUpdate.mock.calls[0][0].data
    expect(updateData).not.toHaveProperty("contractualTotalInterest")
    expect(updateData).not.toHaveProperty("contractualTotalRepayable")
  })

  it("marks a DEFAULTED loan COMPLETED when a payment settles it in full", async () => {
    const { db, loanUpdate, auditCreate } = makeDb(makeLoan("DEFAULTED"))

    // 600_000 repayable - 100_000 paid = 500_000 outstanding
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, { ...input, amount: 500_000 })

    expect(loanUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "COMPLETED", closedAt: expect.any(Date) }),
      }),
    )
    expect(auditCreate).toHaveBeenCalledTimes(2)
    expect(auditCreate).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        action: "LOAN_STATUS_CHANGED",
        oldValue: expect.objectContaining({ status: "DEFAULTED", closedAt: null }),
        newValue: expect.objectContaining({ status: "COMPLETED", reason: "settled_by_payment" }),
      }),
    })
  })

  it("closes a loan settled by a back-dated receipt on its latest receipt's value date", async () => {
    const { db, loanUpdate, auditCreate, paymentFindFirst } = makeDb(makeLoan("DEFAULTED"))
    const later = new Date("2026-01-20T08:00:00.000Z")
    paymentFindFirst.mockResolvedValue({ receivedAt: later })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, { ...input, amount: 500_000, receivedAt: new Date("2026-01-10T08:00:00.000Z") })
    expect(loanUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED", closedAt: later }),
    }))
    expect(auditCreate).toHaveBeenNthCalledWith(2, { data: expect.objectContaining({
      newValue: expect.objectContaining({ closedAt: later.toISOString() }),
    }) })
  })

  it("rejects a non-active loan (WRITTEN_OFF) with NOT_ACTIVE and creates no payment", async () => {
    const { db, paymentCreate } = makeDb(makeLoan("WRITTEN_OFF"))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyManualReceipt(db as any, input)).rejects.toMatchObject({ code: "NOT_ACTIVE" })
    expect(paymentCreate).not.toHaveBeenCalled()
  })

  it("banks money past settlement instead of refusing it", async () => {
    const { db, paymentCreate } = makeDb(makeLoan("ACTIVE"))

    // settlementDue = 600_000 - 100_000 = 500_000. The extra cent is real money
    // that already arrived — refusing the receipt outright (the old behaviour)
    // left it in the bank account with nothing in the ledger to match it.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, { ...input, amount: 500_001 })

    expect(paymentCreate).toHaveBeenCalledTimes(2)
    expect(paymentCreate.mock.calls[1][0].data).toMatchObject({
      amount: 1,
      allocationStatus: "UNAPPLIED",
      reconciliationReason: "overpayment_refund_due",
    })
  })

  it("settles DAILY_ACCRUAL on day 15 with only accrued interest and an audited rebate", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"))
    const daily = makeLoan("ACTIVE", {
      principal: 200_000,
      totalInterest: 10_000,
      totalPaid: 0,
      totalRepayable: 246_900,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
      interestRatePm: 0.05,
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
    })
    const { db, scheduleUpdate, loanUpdate, auditCreate } = makeDb(daily)

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyManualReceipt(db as any, {
        ...input,
        amount: 241_900,
      })
    } finally {
      vi.useRealTimers()
    }

    expect(scheduleUpdate).toHaveBeenCalledWith({
      where: { id: "sched-1", tenantId: "t1" },
      data: expect.objectContaining({
        interestDue: 5_000,
        totalDue: 241_900,
        totalPaid: 241_900,
        status: "PAID",
      }),
    })
    expect(loanUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        totalInterest: 5_000,
        totalRepayable: 241_900,
        contractualTotalInterest: 10_000,
        contractualTotalRepayable: 246_900,
        totalPaid: 241_900,
        status: "COMPLETED",
      }),
    }))
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PAYMENT_RECORDED",
        newValue: expect.objectContaining({
          earlyDailySettlement: true,
          accruedInterest: 5_000,
          interestRebate: 5_000,
          resultingTotalInterest: 5_000,
          resultingTotalRepayable: 241_900,
          contractualTotalInterest: 10_000,
          contractualTotalRepayable: 246_900,
        }),
      }),
    })
  })

  it("rejects a missing loan with NOT_FOUND", async () => {
    const { db, paymentCreate } = makeDb(null)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyManualReceipt(db as any, input)).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(paymentCreate).not.toHaveBeenCalled()
  })
})

describe("applyManualReceipt — over-payment split (NCA s125)", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  // Early settlement: R2,469.00 maturity total, client paid R2,500.00 on day 17
  // of a 30-day term. s125(2)(b) charges 17 days of interest (R56.67, not the
  // contractual R100.00), so R2,425.67 settles the loan and R74.33 goes back.
  const DAY_17 = new Date("2026-07-18T10:00:00.000Z")

  function makeDailyLoan() {
    return makeLoan("ACTIVE", {
      principal: 200_000,
      totalInterest: 10_000,
      totalPaid: 0,
      totalRepayable: 246_900,
      contractualTotalInterest: null,
      contractualTotalRepayable: null,
      interestRatePm: 0.05,
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
    })
  }

  it("settles the loan and books the balance as a refund due to the client", async () => {
    // Pricing is now driven by asOf, so the clock stands in for the
    // value date this test used to pass explicitly.
    vi.setSystemTime(DAY_17)
    const { db, paymentCreate, loanUpdate } = makeDb(makeDailyLoan())

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyManualReceipt(db as any, {
      ...input, amount: 250_000,
    })

    expect(paymentCreate).toHaveBeenCalledTimes(2)
    expect(paymentCreate.mock.calls[0][0].data).toMatchObject({
      amount: 242_567,
    })
    expect(paymentCreate.mock.calls[1][0].data).toMatchObject({
      amount: 7_433,
      allocationStatus: "UNAPPLIED",
      reconciliationReason: "overpayment_refund_due",
      parentPaymentId: "pay-1",
    })
    expect(result.excessPayment?.amount).toBe(7_433)
    expect(loanUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "COMPLETED" }),
    }))
  })

  it("keeps the refund-due excess out of the loan's collected total", async () => {
    // Pricing is now driven by asOf, so the clock stands in for the
    // value date this test used to pass explicitly.
    vi.setSystemTime(DAY_17)
    // The excess is money held for the client, not a repayment. If it lands in
    // totalPaid the statement and certificate of balance both over-report what
    // was collected on an NCA account.
    const { db, loanUpdate } = makeDb(makeDailyLoan())

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, { ...input, amount: 250_000 })

    expect(loanUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        totalPaid: 242_567,
        lastPaymentAmount: 242_567,
      }),
    }))
  })






  it("banks a receipt on an already-settled loan without touching it or claiming it closed", async () => {
    // Pricing is now driven by asOf, so the clock stands in for the
    // value date this test used to pass explicitly.
    vi.setSystemTime(DAY_17)
    // settlementDue is 0, so there is no allocated portion at all. The receipt
    // must be recorded whole as refund-due, the loan must not be written, and
    // — the part a settlement-level test cannot see — no LOAN_STATUS_CHANGED
    // audit may claim a COMPLETED transition that never happened.
    const settled = makeDailyLoan()
    settled.totalPaid = 242_567
    settled.repaymentSchedule[0].totalPaid = 242_567
    const { db, paymentCreate, loanUpdate, scheduleUpdate, auditCreate } = makeDb(settled)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyManualReceipt(db as any, {
      ...input, amount: 50_000,
    })

    expect(paymentCreate).toHaveBeenCalledTimes(1)
    expect(paymentCreate.mock.calls[0][0].data).toMatchObject({
      amount: 50_000,
      allocationStatus: "UNAPPLIED",
      reconciliationReason: "overpayment_refund_due",
    })
    expect(result.excessPayment).toBeNull()
    expect(loanUpdate).not.toHaveBeenCalled()
    expect(scheduleUpdate).not.toHaveBeenCalled()
    expect(auditCreate).toHaveBeenCalledOnce()
    expect(auditCreate.mock.calls[0][0].data.action).toBe("PAYMENT_RECORDED")
  })

  it("recognises a replayed over-payment from the receipt group total", async () => {
    // Pricing is now driven by asOf, so the clock stands in for the
    // value date this test used to pass explicitly.
    vi.setSystemTime(DAY_17)
    // The allocated half stores R2,425.67 while the request was R2,500.00.
    // Comparing the request against the allocated amount alone raises a false
    // IDEMPOTENCY_CONFLICT; staff then retry with a fresh key and the client is
    // banked twice.
    const { db, paymentCreate, loanUpdate } = makeDb(makeDailyLoan(), {
      id: "pay-existing",
      tenantId: "t1",
      loanId: "loan-1",
      amount: 242_567,
      paymentMethod: "EFT",
      reference: null,
      notes: null,
      capturedBy: "agent-1",
      excessPayments: [{ id: "pay-excess", amount: 7_433 }],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyManualReceipt(db as any, {
      ...input,
      amount: 250_000,
      idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
    })

    expect(result.idempotentReplay).toBe(true)
    expect(paymentCreate).not.toHaveBeenCalled()
    expect(loanUpdate).not.toHaveBeenCalled()
  })




})

describe("applyManualReceipt — idempotency and atomic audit evidence", () => {
  const keyedInput = {
    ...input,
    capturedByEmail: "agent@example.test",
    idempotencyKey: "550e8400-e29b-41d4-a716-446655440000",
  }
  const existingPayment = {
    id: "pay-existing",
    tenantId: "t1",
    loanId: "loan-1",
    amount: 50_000,
    paymentMethod: "EFT",
    reference: null,
    notes: null,
    capturedBy: "agent-1",
  }

  it("returns the original receipt without touching balances or audit on an exact replay", async () => {
    const {
      db, queryRaw, executeRaw, findUnique, paymentCreate, scheduleUpdate, loanUpdate, auditCreate,
    } = makeDb(makeLoan("ACTIVE"), existingPayment)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyManualReceipt(db as any, keyedInput)

    expect(result).toEqual({
      payment: existingPayment,
      excessPayment: null,
      idempotentReplay: true,
    })
    expect(executeRaw).toHaveBeenCalledOnce()
    expect(queryRaw).not.toHaveBeenCalled()
    expect(findUnique).not.toHaveBeenCalled()
    expect(paymentCreate).not.toHaveBeenCalled()
    expect(scheduleUpdate).not.toHaveBeenCalled()
    expect(loanUpdate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })

  it("rejects reuse of a key for a different payload before touching the loan", async () => {
    const { db, findUnique, paymentCreate, auditCreate } = makeDb(
      makeLoan("ACTIVE"),
      { ...existingPayment, amount: 49_999 },
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyManualReceipt(db as any, keyedInput)).rejects.toMatchObject({
      code: "IDEMPOTENCY_CONFLICT",
    })
    expect(findUnique).not.toHaveBeenCalled()
    expect(paymentCreate).not.toHaveBeenCalled()
    expect(auditCreate).not.toHaveBeenCalled()
  })



  it("persists the key and mandatory payment audit in the receipt transaction", async () => {
    const { db, queryRaw, executeRaw, paymentCreate, auditCreate } = makeDb(makeLoan("ACTIVE"))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await applyManualReceipt(db as any, keyedInput)

    expect(result.idempotentReplay).toBe(false)
    expect(executeRaw).toHaveBeenCalledTimes(2)
    expect(queryRaw).toHaveBeenCalledOnce()
    expect(paymentCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ idempotencyKey: keyedInput.idempotencyKey }),
    })
    expect(auditCreate).toHaveBeenCalledOnce()
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "PAYMENT_RECORDED",
        userEmail: "agent@example.test",
        newValue: expect.objectContaining({ idempotencyKey: keyedInput.idempotencyKey }),
      }),
    })
    expect(executeRaw).toHaveBeenLastCalledWith("SET CONSTRAINTS ALL IMMEDIATE")
    expect(auditCreate.mock.invocationCallOrder.at(-1)).toBeLessThan(
      executeRaw.mock.invocationCallOrder.at(-1)!,
    )
  })

  it("fails the receipt when its mandatory audit row cannot be written", async () => {
    const { db, paymentCreate, loanUpdate, auditCreate } = makeDb(makeLoan("ACTIVE"))
    auditCreate.mockRejectedValueOnce(new Error("audit unavailable"))

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(applyManualReceipt(db as any, keyedInput)).rejects.toThrow("audit unavailable")
    expect(paymentCreate).toHaveBeenCalledOnce()
    expect(loanUpdate).toHaveBeenCalledOnce()
  })
})

describe("applyManualReceipt — value date", () => {
  const DAY_17 = new Date("2026-07-18T10:00:00.000Z")

  function dailyLoan() {
    return makeLoan("ACTIVE", {
      principal: 200_000, totalInterest: 10_000, totalRepayable: 246_900,
      interestModel: "DAILY_ACCRUAL",
      startDate: new Date("2026-07-01T08:00:00.000Z"),
      maturityDate: new Date("2026-07-31T08:00:00.000Z"),
      repaymentSchedule: [{
        id: "s1", dueDate: new Date("2026-07-31T08:00:00.000Z"),
        principalDue: 200_000, interestDue: 10_000, feesDue: 36_900,
        totalDue: 246_900, totalPaid: 0,
      }],
    })
  }

  // The whole point: a deposit that arrived on day 10 but is captured on day 17
  // must be priced at day 10. Charging to capture time bills seven days of
  // credit the client never had (NCA s125(2)(b)).
  it("prices the settlement at the value date, not the capture date", async () => {
    vi.useFakeTimers(); vi.setSystemTime(DAY_17)
    try {
      const { db, loanUpdate } = makeDb(dailyLoan())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyManualReceipt(db as any, {
        ...input, amount: 240_233,
        receivedAt: new Date("2026-07-11T00:00:00.000Z"),
      })
      const data = loanUpdate.mock.calls[0][0].data
      // 10 elapsed days of R10 000 contractual interest over 30 = R33.33.
      // Priced at capture time (day 17) it would be R56.67, and at maturity
      // R100.00 — so this number is only reachable via the value date.
      expect(data.totalInterest).toBe(3_333)
      expect(data.status).toBe("COMPLETED")
    } finally { vi.useRealTimers() }
  })

  it("refuses a future value date", async () => {
    vi.useFakeTimers(); vi.setSystemTime(DAY_17)
    try {
      const { db, paymentCreate } = makeDb(dailyLoan())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(applyManualReceipt(db as any, {
        ...input, amount: 100_000, receivedAt: new Date("2026-07-25T00:00:00.000Z"),
      })).rejects.toMatchObject({ code: "INVALID_VALUE_DATE" })
      expect(paymentCreate).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  // The Critical three reviews kept finding: a months-old date prices the loan
  // at zero elapsed days and writes off every cent of earned interest.
  it("refuses a back-date that writes off material interest, unauthorised", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-18T10:00:00.000Z"))
    try {
      const { db, paymentCreate, loanUpdate } = makeDb(dailyLoan())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(applyManualReceipt(db as any, {
        ...input, amount: 100_000, receivedAt: new Date("2026-07-01T08:00:00.000Z"),
      })).rejects.toMatchObject({ code: "INVALID_VALUE_DATE" })
      // Nothing written — not the receipt, not the rebate.
      expect(paymentCreate).not.toHaveBeenCalled()
      expect(loanUpdate).not.toHaveBeenCalled()
    } finally { vi.useRealTimers() }
  })

  it("allows it with a reasoned senior override, and records the rebate", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-09-18T10:00:00.000Z"))
    try {
      const { db, paymentCreate, auditCreate } = makeDb(dailyLoan())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyManualReceipt(db as any, {
        ...input, amount: 236_900,
        receivedAt: new Date("2026-07-01T08:00:00.000Z"),
        valueDateOverride: {
          reason: "Deposit slip surfaced during the September branch reconciliation.",
          approvedById: "admin-1", approvedByEmail: "admin@acme-lending.example",
        },
      })
      expect(paymentCreate).toHaveBeenCalled()
      const audit = auditCreate.mock.calls
        .map((c) => c[0].data)
        .find((d: { action: string }) => d.action === "PAYMENT_RECORDED")
      // The rebate is what the back-dating COST; the date alone would hide it.
      expect(audit.newValue).toMatchObject({
        source: "STAFF_ASSERTED",
        daysBackdated: 79,
        override: expect.objectContaining({ approvedById: "admin-1" }),
      })
      expect(audit.newValue.interestRebateCents).toBeGreaterThan(0)
    } finally { vi.useRealTimers() }
  })

  it("stores the value date on the receipt", async () => {
    vi.useFakeTimers(); vi.setSystemTime(DAY_17)
    try {
      const { db, paymentCreate } = makeDb(dailyLoan())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await applyManualReceipt(db as any, {
        ...input, amount: 100_000, receivedAt: new Date("2026-07-11T00:00:00.000Z"),
      })
      expect(paymentCreate.mock.calls[0][0].data).toMatchObject({
        receivedAt: new Date("2026-07-11T00:00:00.000Z"),
      })
    } finally { vi.useRealTimers() }
  })
})

describe("applyManualReceipt — machine writers (collections engine)", () => {
  it("audits a staff capture under the capturing user, dated STAFF_ASSERTED, by default", async () => {
    const { db, auditCreate } = makeDb(makeLoan("ACTIVE"))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, input)
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ userId: "agent-1", newValue: expect.objectContaining({ source: "STAFF_ASSERTED" }) }),
    })
  })

  it("keeps a machine label off the User foreign key and records who dated the receipt", async () => {
    const { db, auditCreate, paymentCreate } = makeDb(makeLoan("ACTIVE"))
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await applyManualReceipt(db as any, {
      ...input, capturedById: "collections-engine", auditUserId: null, valueDateSource: "SYSTEM_OBSERVED", paymentMethod: "DEBIT_ORDER",
    })
    expect(paymentCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ capturedBy: "collections-engine", paymentMethod: "DEBIT_ORDER" }) })
    expect(auditCreate.mock.calls.length).toBeGreaterThan(0)
    for (const [call] of auditCreate.mock.calls) {
      expect(call.data.userId).toBeNull()
    }
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ newValue: expect.objectContaining({ source: "SYSTEM_OBSERVED" }) }),
    })
  })
})
