import { describe, expect, it, vi } from "vitest"
import { writeReceiptSchedule, type WrittenRow } from "./write-schedule"

const row = (id: string, change: Partial<WrittenRow> = {}): WrittenRow => ({
  id, interestDue: 5_000, feesDue: 9_150, creditLifePremiumDue: 2_250, totalDue: 114_150, totalPaid: 0, status: "PENDING", paidAt: null, ...change,
})
const tx = () => {
  const update = vi.fn(async () => ({}))
  return { update, tx: { repaymentSchedule: { update } } as never }
}
const paidAt = new Date("2026-10-10T08:00:00.000Z")

describe("writeReceiptSchedule", () => {
  it("writes a re-priced row whole: interest, fees, the premium inside them, total and paid", async () => {
    const { update, tx: db } = tx()
    const before = [row("r1")]
    const after = [row("r1", { interestDue: 2_667, feesDue: 0, creditLifePremiumDue: 0, totalDue: 102_667, totalPaid: 102_667 })]
    await writeReceiptSchedule(db, before, after, { tenantId: "t1", paidAt })
    expect(update).toHaveBeenCalledWith({
      where: { id: "r1", tenantId: "t1" },
      data: { totalPaid: 102_667, interestDue: 2_667, feesDue: 0, creditLifePremiumDue: 0, totalDue: 102_667, status: "PAID", paidAt },
    })
  })

  it("skips an unchanged row, and never writes a premium the projection did not carry", async () => {
    const { update, tx: db } = tx()
    const before = [row("r1"), row("r2")]
    const after = [row("r1"), { ...row("r2", { totalPaid: 50_000 }), creditLifePremiumDue: undefined }]
    await writeReceiptSchedule(db, before, after, { tenantId: "t1", paidAt })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      where: { id: "r2", tenantId: "t1" },
      data: { totalPaid: 50_000, interestDue: 5_000, feesDue: 9_150, totalDue: 114_150, status: "PARTIAL", paidAt: null },
    })
  })

  it("keeps an earlier paid date and marks an untouched unpaid row PENDING when asked (reversal, reconcile)", async () => {
    const { update, tx: db } = tx()
    const earlier = new Date("2026-08-24T08:00:00.000Z")
    const before = [row("r1", { totalPaid: 114_150, status: "PAID", paidAt: earlier }), row("r2", { totalPaid: 10_000, status: "PARTIAL" })]
    const after = [row("r1", { totalPaid: 114_150, interestDue: 5_000 }), row("r2", { totalPaid: 0 })]
    await writeReceiptSchedule(db, before, after, { tenantId: "t1", paidAt, keepEarlierPaidAt: true, pendingWhenNothingPaid: true })
    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "r2", tenantId: "t1" }, data: expect.objectContaining({ status: "PENDING", paidAt: null }) }))
  })
})
