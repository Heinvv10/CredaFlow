import { describe, expect, it } from "vitest"
import { seedBookReceipts } from "./seed-book"

const window = { start: "2026-04-01", until: "2026-10-16", lastBusinessDay: "2026-10-15" }
const row = (installmentNo: number, dueDay: string, totalDue: number, totalPaid = 0) => ({ installmentNo, dueDay, totalDue, totalPaid })

describe("seedBookReceipts: the base seed's loans are kept current through the bake", () => {
  const loan = {
    id: "loan-1", reference: "LN-SEED-0001",
    rows: [
      row(1, "2026-03-25", 100_00, 100_00), // fell due before the window, paid by the seed
      row(2, "2026-04-25", 100_00, 100_00), // paid in advance by the seed's early receipt
      row(3, "2026-05-25", 100_00, 40_00), // part-paid in advance
      row(4, "2026-06-27", 100_00), // a Saturday
      row(5, "2026-10-17", 100_00), // after the end date
    ],
  }

  it("pays what is still owed on each instalment on its due date (the next business day), inside the window", () => {
    expect(seedBookReceipts(loan, window)).toEqual([
      { id: "seed-book:LN-SEED-0001:instalment-3", day: "2026-05-25", amountCents: 60_00, installmentNo: 3 },
      { id: "seed-book:LN-SEED-0001:instalment-4", day: "2026-06-29", amountCents: 100_00, installmentNo: 4 },
    ])
  })

  it("leaves a loan with nothing due inside the window alone", () => {
    expect(seedBookReceipts({ ...loan, rows: [row(1, "2026-11-01", 100_00)] }, window)).toEqual([])
  })
})
