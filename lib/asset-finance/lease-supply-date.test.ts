import { describe, expect, it, vi } from "vitest"
import { cashReachedOn } from "./lease-supply-date"

/** Rental 2 of a lease whose rental 1 is R100.00: the cash reaches rental 2 once it passes R100.00. */
function tx(payments: { amount: number; on: string; defaultInterestAllocated?: number; chargeFeesAllocated?: number }[]) {
  const findMany = vi.fn(async () => payments
    .map((p) => ({ amount: p.amount, defaultInterestAllocated: p.defaultInterestAllocated ?? 0, chargeFeesAllocated: p.chargeFeesAllocated ?? 0, receivedAt: new Date(`${p.on}T10:00:00+02:00`) }))
    .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime()))
  return { findMany, tx: { repaymentSchedule: { aggregate: vi.fn(async () => ({ _sum: { totalDue: 10_000 } })) }, payment: { findMany } } }
}
const reached = (payments: Parameters<typeof tx>[0]) => cashReachedOn(tx(payments).tx as never, { tenantId: "t1", loanId: "l1", periodNo: 2 })

describe("cashReachedOn: the day the cash first reached a rental (C4)", () => {
  it("a back-dated receipt captured after a later one: R5.00 on 15 Mar, R100.00 on 20 Mar → reached on 20 Mar, not 15 Mar", async () => {
    expect(await reached([{ amount: 10_000, on: "2027-03-20" }, { amount: 500, on: "2027-03-15" }])).toBe("2027-03-20")
  })
  it("exactly the earlier rows' dues has not reached it; one cent more has", async () => {
    expect(await reached([{ amount: 10_000, on: "2027-03-20" }])).toBeNull()
    expect(await reached([{ amount: 10_001, on: "2027-03-20" }])).toBe("2027-03-20")
  })
  it("the default charges a receipt paid are not cash towards the rentals", async () => {
    expect(await reached([{ amount: 10_200, on: "2027-03-20", defaultInterestAllocated: 150, chargeFeesAllocated: 50 }])).toBeNull()
  })
  it("asks only for allocated, unreversed, non-waiver receipts of the loan, oldest first, against the rows before the rental", async () => {
    const t = tx([])
    await cashReachedOn(t.tx as never, { tenantId: "t1", loanId: "l1", periodNo: 2 })
    expect((t.tx.repaymentSchedule.aggregate.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({ where: { tenantId: "t1", loanId: "l1", installmentNo: { lt: 2 } } })
    expect((t.findMany.mock.calls[0] as unknown as [unknown])[0]).toMatchObject({
      where: { tenantId: "t1", loanId: "l1", reversed: false, allocationStatus: "ALLOCATED", paymentMethod: { not: "WAIVER" } },
      orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
    })
  })
})
