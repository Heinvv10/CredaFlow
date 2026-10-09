import { describe, expect, it, vi } from "vitest"
import { replayPaidAt, restampSchedulePaidAt } from "./schedule-paid-at"

const d = (day: string) => new Date(`${day}T10:00:00+02:00`)
const rows = (...totals: number[]) => totals.map((totalDue) => ({ principalDue: totalDue, interestDue: 0, totalDue }))

describe("replayPaidAt", () => {
  it("dates each instalment by the receipt that completed it, not the one that started it", () => {
    expect(replayPaidAt(rows(500, 500), [
      { receivedAt: d("2026-06-29"), share: 300 },
      { receivedAt: d("2026-07-20"), share: 400 },
      { receivedAt: d("2026-08-05"), share: 300 },
    ])).toEqual([d("2026-07-20"), d("2026-08-05")])
  })

  it("leaves a partly paid instalment undated", () => {
    expect(replayPaidAt(rows(500, 500), [
      { receivedAt: d("2026-06-29"), share: 500 },
      { receivedAt: d("2026-07-20"), share: 499 },
    ])).toEqual([d("2026-06-29"), null])
  })

  it("dates one receipt that pays several instalments on all of them", () => {
    expect(replayPaidAt(rows(500, 500, 500), [{ receivedAt: d("2026-06-29"), share: 1_000 }]))
      .toEqual([d("2026-06-29"), d("2026-06-29"), null])
  })

  it("after a reversal, re-dates an instalment the remaining receipts still cover", () => {
    // The receipts the caller passes are the live ones: the reversed 29 Jun
    // receipt is simply absent, so 20 Jul's completes instalment 1.
    expect(replayPaidAt(rows(500, 500), [{ receivedAt: d("2026-07-20"), share: 500 }]))
      .toEqual([d("2026-07-20"), null])
  })

  it("after several reversals, re-dates from what is left", () => {
    const live = [
      { receivedAt: d("2026-06-29"), share: 300 },
      { receivedAt: d("2026-07-20"), share: 400 },
      { receivedAt: d("2026-08-05"), share: 300 },
    ]
    expect(replayPaidAt(rows(500, 500), live.slice(1))).toEqual([d("2026-08-05"), null])
    expect(replayPaidAt(rows(500, 500), live.slice(2))).toEqual([null, null])
  })

  it("dates nothing when no receipt is left", () => {
    expect(replayPaidAt(rows(500, 500), [])).toEqual([null, null])
  })

  it("dates an instalment a waiver completes by the waiver", () => {
    // A small-balance waiver is an ALLOCATED receipt dated when it was granted.
    expect(replayPaidAt(rows(500, 500), [
      { receivedAt: d("2026-06-29"), share: 500 },
      { receivedAt: d("2026-07-20"), share: 499 },
      { receivedAt: d("2026-08-25"), share: 1 },
    ])).toEqual([d("2026-06-29"), d("2026-08-25")])
  })

  it("fills instalment by instalment, as the books do while charges are off", () => {
    // s126(3) would pay both instalments' interest first and leave instalment
    // 1 R100 short; the legacy allocator completes it.
    const withInterest = [0, 1].map(() => ({ principalDue: 400, interestDue: 100, totalDue: 500 }))
    expect(replayPaidAt(withInterest, [{ receivedAt: d("2026-06-29"), share: 500 }]))
      .toEqual([d("2026-06-29"), null])
  })

  it("replays in the order given: the caller supplies the books' order", () => {
    expect(replayPaidAt(rows(500, 500), [
      { receivedAt: d("2026-07-20"), share: 500 },
      { receivedAt: d("2026-06-29"), share: 500 },
    ])).toEqual([d("2026-07-20"), d("2026-06-29")])
  })
})

describe("restampSchedulePaidAt", () => {
  const ref = { tenantId: "tenant-1", loanId: "loan-1" }
  const actor = { source: "payment_reversal", userId: "user-1", userEmail: "staff@test.invalid" }

  function tx(
    schedule: Array<{ id: string; totalDue: number; totalPaid: number; paidAt: Date | null }>,
    receipts: Array<{ receivedAt: Date; amount: number; defaultInterestAllocated?: number; chargeFeesAllocated?: number }>,
  ) {
    return {
      repaymentSchedule: {
        findMany: vi.fn(async () => schedule.map((row, i) => ({ ...row, installmentNo: i + 1, principalDue: row.totalDue, interestDue: 0 }))),
        update: vi.fn(async () => ({})),
      },
      payment: {
        findMany: vi.fn(async () => receipts.map((r) => ({ defaultInterestAllocated: 0, chargeFeesAllocated: 0, ...r }))),
      },
      auditLog: { create: vi.fn(async (_args: { data: { action: string; newValue: unknown } }) => ({})) },
    }
  }

  it("reads the loan's live receipts in the books' order and its rows in due-date order", async () => {
    const t = tx([], [])
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", loanId: "loan-1", reversed: false, allocationStatus: "ALLOCATED" },
      orderBy: [{ receivedAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    }))
    expect(t.repaymentSchedule.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", loanId: "loan-1" },
      orderBy: [{ dueDate: "asc" }, { installmentNo: "asc" }],
    }))
  })

  it("writes only paidAt, and only on the rows whose date moved — including rows whose amounts did not", async () => {
    const t = tx(
      [
        { id: "r1", totalDue: 500, totalPaid: 500, paidAt: d("2026-06-29") },
        { id: "r2", totalDue: 500, totalPaid: 0, paidAt: null },
      ],
      [{ receivedAt: d("2026-07-20"), amount: 500 }],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.repaymentSchedule.update.mock.calls).toEqual([
      [{ where: { id: "r1", tenantId: "tenant-1" }, data: { paidAt: d("2026-07-20") } }],
    ])
  })

  it("clears a date left on a row that is no longer fully paid", async () => {
    const t = tx(
      [{ id: "r1", totalDue: 500, totalPaid: 300, paidAt: d("2026-06-29") }],
      [{ receivedAt: d("2026-07-20"), amount: 300 }],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.repaymentSchedule.update.mock.calls).toEqual([
      [{ where: { id: "r1", tenantId: "tenant-1" }, data: { paidAt: null } }],
    ])
  })

  it("replays only each receipt's schedule share, not what it paid in default charges", async () => {
    // R1,060 of which R60 went to default interest and R40 to fees: R960
    // reaches the schedule, so instalment 2 is completed by 5 Aug's R40.
    const t = tx(
      [
        { id: "r1", totalDue: 500, totalPaid: 500, paidAt: null },
        { id: "r2", totalDue: 500, totalPaid: 500, paidAt: null },
      ],
      [
        { receivedAt: d("2026-07-20"), amount: 1_060, defaultInterestAllocated: 60, chargeFeesAllocated: 40 },
        { receivedAt: d("2026-08-05"), amount: 40 },
      ],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.repaymentSchedule.update.mock.calls).toEqual([
      [{ where: { id: "r1", tenantId: "tenant-1" }, data: { paidAt: d("2026-07-20") } }],
      [{ where: { id: "r2", tenantId: "tenant-1" }, data: { paidAt: d("2026-08-05") } }],
    ])
  })

  it("re-dates nothing, and audits why, when a paid row is not one the receipts complete", async () => {
    // Shares and schedule agree in total (R900) but not in where the money
    // sits: the books fill instalment 1 first, the rows say instalment 2.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const t = tx(
      [
        { id: "r1", totalDue: 500, totalPaid: 400, paidAt: null },
        { id: "r2", totalDue: 500, totalPaid: 500, paidAt: d("2026-07-01") },
      ],
      [{ receivedAt: d("2026-07-20"), amount: 900 }],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.repaymentSchedule.update).not.toHaveBeenCalled()
    expect(t.auditLog.create.mock.calls.map(([arg]) => [arg.data.action, arg.data.newValue])).toEqual([[
      "SCHEDULE_PAIDAT_RESTAMP_SKIPPED",
      {
        reason: "paid_row_not_completed_by_receipts", source: "payment_reversal", loanId: "loan-1",
        receiptShares: 900, schedulePaid: 900, undatableInstalments: [2], mismatchedInstalments: [1, 2],
      },
    ]])
    warn.mockRestore()
  })

  it("re-dates nothing, and audits why, when the rows split the right total differently from the receipts", async () => {
    // R1,000 on both sides and no paid row left undated, but the books would
    // fill instalment 2 before touching 3.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    const t = tx(
      [
        { id: "r1", totalDue: 500, totalPaid: 500, paidAt: null },
        { id: "r2", totalDue: 500, totalPaid: 200, paidAt: null },
        { id: "r3", totalDue: 500, totalPaid: 300, paidAt: null },
      ],
      [{ receivedAt: d("2026-07-20"), amount: 1_000 }],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.repaymentSchedule.update).not.toHaveBeenCalled()
    expect(t.auditLog.create.mock.calls.map(([arg]) => arg.data.newValue)).toEqual([{
      reason: "row_allocation_mismatch", source: "payment_reversal", loanId: "loan-1",
      receiptShares: 1_000, schedulePaid: 1_000, undatableInstalments: [], mismatchedInstalments: [2, 3],
    }])
    warn.mockRestore()
  })

  it("leaves a row that owes nothing with its own date", async () => {
    const t = tx(
      [
        { id: "r0", totalDue: 0, totalPaid: 0, paidAt: d("2026-06-01") },
        { id: "r1", totalDue: 500, totalPaid: 500, paidAt: null },
      ],
      [{ receivedAt: d("2026-07-20"), amount: 500 }],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.auditLog.create).not.toHaveBeenCalled()
    expect(t.repaymentSchedule.update.mock.calls).toEqual([
      [{ where: { id: "r1", tenantId: "tenant-1" }, data: { paidAt: d("2026-07-20") } }],
    ])
  })

  describe("when the receipts do not add up to what the schedule records as paid", () => {
    // Instalment 1 marked paid with no receipt behind it; one R500 receipt on 20 Jul.
    const broken = () => tx(
      [
        { id: "r1", totalDue: 500, totalPaid: 500, paidAt: d("2026-06-29") },
        { id: "r2", totalDue: 500, totalPaid: 500, paidAt: d("2026-07-20") },
      ],
      [{ receivedAt: d("2026-07-20"), amount: 500 }],
    )

    it("re-dates nothing, and audits the skip with both totals and the writer", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
      const t = broken()
      await expect(restampSchedulePaidAt(t as never, ref, actor)).resolves.toBeUndefined()
      expect(t.repaymentSchedule.update).not.toHaveBeenCalled()
      const detail = {
        reason: "ledger_identity_broken", source: "payment_reversal", loanId: "loan-1",
        receiptShares: 500, schedulePaid: 1_000, undatableInstalments: [2], mismatchedInstalments: [2],
      }
      expect(t.auditLog.create.mock.calls).toEqual([[{
        data: {
          tenantId: "tenant-1", userId: "user-1", userEmail: "staff@test.invalid",
          action: "SCHEDULE_PAIDAT_RESTAMP_SKIPPED", entity: "Loan", entityId: "loan-1", newValue: detail,
        },
      }]])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("loan-1"), detail)
      warn.mockRestore()
    })

    it("audits nothing when they agree", async () => {
      const t = tx(
        [{ id: "r1", totalDue: 500, totalPaid: 500, paidAt: d("2026-06-29") }],
        [{ receivedAt: d("2026-07-20"), amount: 500 }],
      )
      await restampSchedulePaidAt(t as never, ref, actor)
      expect(t.auditLog.create).not.toHaveBeenCalled()
      expect(t.repaymentSchedule.update).toHaveBeenCalledTimes(1)
    })
  })

  it("writes nothing when every date already agrees", async () => {
    const t = tx(
      [{ id: "r1", totalDue: 500, totalPaid: 500, paidAt: d("2026-06-29") }],
      [{ receivedAt: d("2026-06-29"), amount: 500 }],
    )
    await restampSchedulePaidAt(t as never, ref, actor)
    expect(t.repaymentSchedule.update).not.toHaveBeenCalled()
  })
})
