import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const loanFindManyMock = vi.fn()
const txQueryRawMock = vi.fn<(...a: unknown[]) => Promise<unknown[]>>(async () => [])
const txExecuteRawUnsafeMock = vi.fn(async (..._a: unknown[]) => 1)
const txLoanFindUniqueMock = vi.fn()
const txPaymentCreateMock = vi.fn<(a: unknown) => void>(() => {})
const txScheduleUpdateMock = vi.fn(async (_a: unknown) => ({}))
const txLoanUpdateMock = vi.fn(async (_a: unknown) => ({}))
const txAuditCreateMock = vi.fn(async (_a: unknown) => ({ id: "audit-1" }))
const logAuditMock = vi.fn()

let payCounter = 0

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findMany: (a: unknown) => loanFindManyMock(a) },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: (...a: unknown[]) => txQueryRawMock(...a),
        $executeRawUnsafe: (...a: unknown[]) => txExecuteRawUnsafeMock(...a),
        loan: {
          findUnique: (a: unknown) => txLoanFindUniqueMock(a),
          update: (a: unknown) => txLoanUpdateMock(a),
        },
        payment: {
          create: (a: { data: Record<string, unknown> }) => {
            txPaymentCreateMock(a)
            return Promise.resolve({ id: `pay-${++payCounter}`, ...a.data })
          },
        },
        repaymentSchedule: { update: (a: unknown) => txScheduleUpdateMock(a) },
        auditLog: { create: (a: unknown) => txAuditCreateMock(a) },
      }),
  },
}))
// Schedule dates are re-derived against real Postgres in
// lib/loan/schedule-paid-at.integration.test.ts.
vi.mock("@/lib/loan/schedule-paid-at", () => ({ restampSchedulePaidAt: vi.fn(async () => undefined) }))
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  logAudit: (a: unknown) => logAuditMock(a),
}))

import { POST } from "./route"
import { ELIZE_INSTALMENT_CENTS, elizeSchedule } from "@/lib/loan/__fixtures__/fairscore-audit-schedules"

function postReq(rows: unknown[]) {
  return new NextRequest("http://x/api/payments/bulk-upload", { method: "POST", body: JSON.stringify({ rows }) })
}

function loanObj(over: Record<string, unknown> = {}) {
  return {
    id: "loanA", status: "ACTIVE",
    principal: 1_000_000, totalInterest: 0, totalPaid: 0, totalRepayable: 1_000_000,
    contractualTotalInterest: null, contractualTotalRepayable: null,
    interestRatePm: 0.05, interestModel: "FLAT",
    startDate: new Date("2026-01-01T00:00:00.000Z"),
    maturityDate: new Date("2026-02-01T00:00:00.000Z"),
    closedAt: null,
    repaymentSchedule: [
      { id: "s1", dueDate: new Date("2026-01-01"), principalDue: 1_000_000, interestDue: 0, feesDue: 0, totalDue: 1_000_000, totalPaid: 0 },
    ],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  payCounter = 0
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@x.co", role: "LOAN_ADMIN" } })
  logAuditMock.mockResolvedValue(undefined)
})

it("locks the loan FOR UPDATE before reading or writing its balance, then processes the row", async () => {
  loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
  txLoanFindUniqueMock.mockResolvedValue(loanObj())

  const res = await POST(postReq([{ reference: "LN-1", amount: 200 }]))
  const body = await res.json()

  expect(res.status).toBe(200)
  expect(body.processed).toBe(1)
  // The lock is a FOR UPDATE on the loan...
  expect(txQueryRawMock).toHaveBeenCalled()
  const sql = ((txQueryRawMock.mock.calls[0] as unknown[])[0] as string[]).join(" ")
  expect(sql).toMatch(/FOR UPDATE/)
  // ...taken BEFORE the balance read and every write.
  const lockOrder = txQueryRawMock.mock.invocationCallOrder[0]
  expect(lockOrder).toBeLessThan(txLoanFindUniqueMock.mock.invocationCallOrder[0])
  expect(lockOrder).toBeLessThan(txPaymentCreateMock.mock.invocationCallOrder[0])
  expect(lockOrder).toBeLessThan(txLoanUpdateMock.mock.invocationCallOrder[0])
  expect(txAuditCreateMock).toHaveBeenCalledWith({
    data: expect.objectContaining({
      action: "PAYMENT_RECORDED",
      entityId: "loanA",
      newValue: expect.objectContaining({ source: "bulk_upload" }),
    }),
  })
  const updateData = (
    txLoanUpdateMock.mock.calls[0][0] as { data: Record<string, unknown> }
  ).data
  expect(updateData).not.toHaveProperty("contractualTotalInterest")
  expect(updateData).not.toHaveProperty("contractualTotalRepayable")
  expect(txExecuteRawUnsafeMock).toHaveBeenLastCalledWith(
    "SET CONSTRAINTS ALL IMMEDIATE",
  )
})

it("compounds multiple receipts to the SAME loan within one locked transaction", async () => {
  loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
  txLoanFindUniqueMock.mockResolvedValue(loanObj())

  const res = await POST(postReq([
    { reference: "LN-1", amount: 200 }, // R200 -> 20000c
    { reference: "LN-1", amount: 300 }, // R300 -> 30000c
  ]))
  const body = await res.json()

  expect(body.processed).toBe(2)
  // One loan => one lock => one balance read for the whole group.
  expect(txQueryRawMock).toHaveBeenCalledTimes(1)
  expect(txLoanFindUniqueMock).toHaveBeenCalledTimes(1)
  // Second write must build on the first (20000 + 30000), not clobber it.
  expect(txLoanUpdateMock).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: expect.objectContaining({ totalPaid: 20_000 }) }))
  expect(txLoanUpdateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: expect.objectContaining({ totalPaid: 50_000 }) }))
})

it("settles a daily-accrual loan at the accrued day-15 amount", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-07-16T10:00:00.000Z"))
  loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
  txLoanFindUniqueMock.mockResolvedValue(loanObj({
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
    }],
  }))

  let body
  try {
    const response = await POST(postReq([{
      reference: "LN-1",
      amount: 2_419,
    }]))
    body = await response.json()
  } finally {
    vi.useRealTimers()
  }

  expect(body.processed).toBe(1)
  expect(txLoanUpdateMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({
      totalInterest: 5_000,
      totalRepayable: 241_900,
      contractualTotalInterest: 10_000,
      contractualTotalRepayable: 246_900,
      status: "COMPLETED",
    }),
  }))
})

it("reports per-row errors and never opens a transaction for bad rows", async () => {
  loanFindManyMock.mockResolvedValue([]) // no loans resolve

  const res = await POST(postReq([
    { reference: "", amount: 200 },          // missing reference
    { reference: "LN-1", amount: 0 },     // invalid amount
    { reference: "LN-9", amount: 200 },   // loan not found
  ]))
  const body = await res.json()

  expect(body.processed).toBe(0)
  expect(body.skipped).toBe(3)
  expect(body.errors.map((e: { reason: string }) => e.reason)).toEqual(
    expect.arrayContaining(["Missing loan reference", "Invalid amount", "Loan not found"]),
  )
  expect(txPaymentCreateMock).not.toHaveBeenCalled()
  expect(txQueryRawMock).not.toHaveBeenCalled()
})

it("locks each distinct loan in its OWN transaction (one lock per tx => no deadlock)", async () => {
  loanFindManyMock.mockResolvedValue([
    { id: "loanA", reference: "LN-1" },
    { id: "loanB", reference: "LN-2" },
  ])
  txLoanFindUniqueMock
    .mockResolvedValueOnce(loanObj({ id: "loanA" }))
    .mockResolvedValueOnce(loanObj({ id: "loanB" }))

  const res = await POST(postReq([
    { reference: "LN-1", amount: 200 },
    { reference: "LN-2", amount: 200 },
  ]))
  const body = await res.json()

  expect(body.processed).toBe(2)
  // Exactly one FOR UPDATE lock per distinct loan (each in its own tx), and the
  // two locks target different loan ids — never both loans in one transaction.
  expect(txQueryRawMock).toHaveBeenCalledTimes(2)
  const lockedIds = txQueryRawMock.mock.calls.map((c) => (c as unknown[])[1])
  expect(new Set(lockedIds)).toEqual(new Set(["loanA", "loanB"]))
})

it("re-sorts the error list back into upload row order", async () => {
  loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
  txLoanFindUniqueMock.mockResolvedValue(null)

  // Row 1 is a loan-not-found error (pushed during the per-loan pass); row 2 is
  // an invalid-amount error (pushed during the earlier parse pass).
  const res = await POST(postReq([
    { reference: "LN-1", amount: 200 },
    { reference: "LN-1", amount: 0 },
  ]))
  const body = await res.json()

  expect(body.errors.map((e: { row: number }) => e.row)).toEqual([1, 2])
})

for (const status of ["WRITTEN_OFF", "PENDING_WRITE_OFF"]) {
  it(`holds money for a ${status} loan for reconciliation (loan_not_allocatable), allocating nothing`, async () => {
    loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
    txLoanFindUniqueMock.mockResolvedValue(loanObj({ status }))

    const body = await (await POST(postReq([{ reference: "LN-1", amount: 200 }]))).json()

    expect(body).toMatchObject({
      processed: 0, skipped: 0, errors: [], refundDue: [],
      held: [expect.objectContaining({ row: 1, amount: 20_000, reason: `Loan status is ${status}` })],
    })
    expect(txPaymentCreateMock).toHaveBeenCalledTimes(1)
    expect(txPaymentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ amount: 20_000, allocationStatus: "UNAPPLIED", reconciliationReason: "loan_not_allocatable" }),
    }))
  })
}

it("records money for a COMPLETED loan as refund-due", async () => {
  loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
  txLoanFindUniqueMock.mockResolvedValue(loanObj({ status: "COMPLETED" }))

  const body = await (await POST(postReq([{ reference: "LN-1", amount: 200 }]))).json()

  expect(body).toMatchObject({ processed: 0, held: [], refundDue: [expect.objectContaining({ row: 1, amount: 20_000 })] })
  expect(txPaymentCreateMock).toHaveBeenCalledWith(expect.objectContaining({
    data: expect.objectContaining({ allocationStatus: "UNAPPLIED", reconciliationReason: "overpayment_refund_due" }),
  }))
})

it("leaves Elize's unpaid future instalments PENDING when a receipt clears her #5 shortfall", async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-10-16T10:00:00.000Z"))
  const schedule = elizeSchedule()
  loanFindManyMock.mockResolvedValue([{ id: "loanA", reference: "LN-1" }])
  txLoanFindUniqueMock.mockResolvedValue(loanObj({
    principal: 3_000_000,
    totalRepayable: ELIZE_INSTALMENT_CENTS * 18,
    totalInterest: ELIZE_INSTALMENT_CENTS * 18 - 3_000_000,
    totalPaid: schedule.reduce((sum, row) => sum + row.totalPaid, 0),
    interestRatePm: 0.03,
    interestModel: "REDUCING_BALANCE",
    startDate: new Date("2026-04-17T06:00:00.000Z"),
    maturityDate: schedule[17].dueDate,
    repaymentSchedule: schedule,
  }))

  try {
    // R843.30, the amount the audit captured for Elize.
    await POST(postReq([{ reference: "LN-1", amount: 843.3 }]))
  } finally {
    vi.useRealTimers()
  }

  const written = txScheduleUpdateMock.mock.calls.map(
    (c) => c[0] as { where: { id: string }; data: { status: string } },
  )
  expect(written.find((w) => w.where.id === "elize-s5")?.data.status).toBe("PAID")
  const future = written.filter((w) => Number(w.where.id.replace("elize-s", "")) > 5)
  for (const w of future) expect(w.data.status).toBe("PENDING")
})
