import { beforeEach, describe, expect, it, vi } from "vitest"

const { applyManualReceiptInTx } = vi.hoisted(() => ({ applyManualReceiptInTx: vi.fn() }))
vi.mock("@/lib/loan/apply-payment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/apply-payment")>()),
  applyManualReceiptInTx,
}))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { allocateMobileMoney } from "./review"
import type { MobileMoneyDb } from "./book"

const T = "t_ke"
const staff = { id: "u1", email: "staff@test.invalid" }

function fakeDb(row: Record<string, unknown>) {
  const audits: Array<Record<string, unknown>> = []
  const updates: Array<Record<string, unknown>> = []
  const tx = {
    // The row lock, then the exact reference match: one loan, l1.
    $queryRaw: async () => [{ id: "l1" }],
    mobileMoneyTransaction: {
      findFirst: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => { updates.push(data); return { ...row, ...data } },
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return data } },
  }
  const db = { $transaction: async (fn: (t: unknown) => Promise<unknown>) => fn(tx) } as unknown as MobileMoneyDb
  return { db, audits, updates }
}

/** An STK push for 1,200.00 the provider reported as paid at 990.00. */
const mismatch = {
  id: "mm1", tenantId: T, status: "NEEDS_REVIEW", transId: "SIMSTK0001", amount: 120_000, reportedAmount: 99_000,
  simulated: true, transactedAt: null, createdAt: new Date("2026-11-08T09:00:00Z"), loanId: "l1",
}
const allocate = (db: MobileMoneyDb, confirmedAmount?: number) =>
  allocateMobileMoney(db, { tenantId: T, id: "mm1", loanReference: "NRB-LN-1", actor: staff, ...(confirmedAmount === undefined ? {} : { confirmedAmount }) })

beforeEach(() => {
  applyManualReceiptInTx.mockReset().mockImplementation(async (_tx: unknown, input: { amount: number }) => ({
    payment: { id: "p1", amount: input.amount, allocationStatus: "ALLOCATED" }, excessPayment: null, idempotentReplay: false,
  }))
})

describe("allocateMobileMoney", () => {
  it("books what the provider reported, never the amount that was pushed, once staff confirm it", async () => {
    const { db, audits } = fakeDb(mismatch)
    await allocate(db, 99_000)
    expect(applyManualReceiptInTx).toHaveBeenCalledTimes(1)
    expect(applyManualReceiptInTx.mock.calls[0][1]).toMatchObject({ amount: 99_000, idempotencyKey: "mpesa-c2b:SIMSTK0001" })
    expect(audits[0]).toMatchObject({
      action: "MOBILE_MONEY_ALLOCATED",
      newValue: expect.objectContaining({ amount: 99_000, requestedAmount: 120_000, reportedAmount: 99_000, amountConfirmedById: "u1" }),
    })
  })

  it("refuses a mismatch row until staff confirm the reported amount itself", async () => {
    for (const confirmed of [undefined, 120_000, 98_999]) {
      const { db, updates } = fakeDb(mismatch)
      await expect(allocate(db, confirmed), String(confirmed)).rejects.toMatchObject({ code: "AMOUNT_UNCONFIRMED" })
      expect(updates).toEqual([])
    }
    expect(applyManualReceiptInTx).not.toHaveBeenCalled()
  })

  it("books a row with no reported difference at its amount, with no confirmation needed", async () => {
    const { db } = fakeDb({ ...mismatch, status: "UNMATCHED", amount: 50_000, reportedAmount: null })
    await allocate(db)
    expect(applyManualReceiptInTx.mock.calls[0][1]).toMatchObject({ amount: 50_000 })
  })
})
