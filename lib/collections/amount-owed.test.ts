import { describe, expect, it } from "vitest"
import { nextInstalmentOwed, nothingOwed } from "./amount-owed"

describe("nothingOwed: the one definition of 'there is nothing to remind about'", () => {
  it.each([
    ["an instalment still due, not overdue", { paymentAmount: 150_000, charges: 0, arrearsAmount: 0, overdue: false }, false],
    ["the instalment paid, no default charges", { paymentAmount: 0, charges: 0, arrearsAmount: 0, overdue: false }, true],
    ["the instalment paid but default charges outstanding", { paymentAmount: 0, charges: 8_000, arrearsAmount: 0, overdue: false }, false],
    ["overdue, arrears cleared, but a next instalment is due", { paymentAmount: 150_000, charges: 0, arrearsAmount: 0, overdue: true }, true],
    ["overdue with arrears", { paymentAmount: 150_000, charges: 0, arrearsAmount: 40_000, overdue: true }, false],
    ["overdue, no arrears but charges outstanding", { paymentAmount: 150_000, charges: 5_000, arrearsAmount: 0, overdue: true }, false],
    ["overdue and nothing unpaid at all", { paymentAmount: 0, charges: 0, arrearsAmount: 0, overdue: true }, true],
  ])("%s", (_name, owed, expected) => {
    expect(nothingOwed(owed)).toBe(expected)
  })
})

describe("nextInstalmentOwed", () => {
  const db = (row: { totalDue: number; totalPaid: number } | null) => ({
    repaymentSchedule: { findFirst: async () => row },
  })
  const ref = { tenantId: "t1", loanId: "l1" }

  it("is what is left of the first unpaid instalment", async () => {
    expect(await nextInstalmentOwed(db({ totalDue: 216_900, totalPaid: 16_900 }), ref)).toBe(200_000)
  })

  it("is 0 with no unpaid instalment, and never negative for an overpaid one", async () => {
    expect(await nextInstalmentOwed(db(null), ref)).toBe(0)
    expect(await nextInstalmentOwed(db({ totalDue: 100, totalPaid: 250 }), ref)).toBe(0)
  })

  it("looks at the tenant's own unpaid, non-zero rows in due order (an asset-finance skip period's R0.00 row is not an instalment)", async () => {
    let seen: unknown
    await nextInstalmentOwed({ repaymentSchedule: { findFirst: async (a: unknown) => ((seen = a), null) } }, ref)
    expect(seen).toMatchObject({
      where: { loanId: "l1", tenantId: "t1", status: { in: ["PENDING", "PARTIAL", "OVERDUE"] }, totalDue: { gt: 0 } },
      orderBy: { dueDate: "asc" },
    })
  })
})
