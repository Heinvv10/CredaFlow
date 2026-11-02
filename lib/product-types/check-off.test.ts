import { describe, expect, it, vi } from "vitest"
import { deductionsCsv, loadDeductions, monthRange } from "./check-off"

describe("monthRange", () => {
  it("is the SAST calendar month, and refuses anything else", () => {
    expect(monthRange("2027-03")).toEqual({ from: new Date("2027-02-28T22:00:00Z"), to: new Date("2027-03-31T22:00:00Z") })
    expect(monthRange("2027-12")!.to).toEqual(new Date("2027-12-31T22:00:00Z"))
    expect(monthRange("2027-13")).toBeNull()
    expect(monthRange("March")).toBeNull()
  })
})

describe("loadDeductions", () => {
  const row = (employer: string | null, last: string, totalDue: number, totalPaid = 0) => ({
    dueDate: new Date("2027-03-24T22:30:00Z"), totalDue, totalPaid,
    loan: { reference: `LN-${last}`, client: { firstName: "Thabo", lastName: last }, application: { productFacts: employer ? { employerName: employer, payrollNumber: "P9" } : null } },
  })
  it("deducts what is still owed on the row, by employer, on the SAST day", async () => {
    const findMany = vi.fn(async () => [row("Zulu Mines", "A", 100_000), row("Acme", "C", 90_000, 40_000), row("Acme", "B", 90_000)])
    const out = await loadDeductions({ repaymentSchedule: { findMany } } as never, "t1", "2027-03")
    expect(out!.map((r) => [r.employer, r.borrower, r.amountCents, r.dueDate])).toEqual([
      ["Acme", "Thabo B", 90_000, "2027-03-25"], ["Acme", "Thabo C", 50_000, "2027-03-25"], ["Zulu Mines", "Thabo A", 100_000, "2027-03-25"],
    ])
    expect(findMany.mock.calls[0]![0 as never]).toMatchObject({ where: { tenantId: "t1", status: { in: ["PENDING", "PARTIAL", "OVERDUE"] }, loan: { status: "ACTIVE", product: { productType: "SALARY_BACKED" } } } })
  })

  it("answers null to a month it cannot read", async () => {
    expect(await loadDeductions({ repaymentSchedule: { findMany: vi.fn() } } as never, "t1", "x")).toBeNull()
  })
})

describe("deductionsCsv", () => {
  it("writes amounts to two decimals and defuses a formula", () => {
    const csv = deductionsCsv([{ employer: "=HYPERLINK(1)", payrollNumber: 'P"1', borrower: "A B", loanReference: "LN-1", dueDate: "2027-03-25", amountCents: 123_405 }])
    expect(csv).toContain(`"'=HYPERLINK(1)","P""1","A B","LN-1","2027-03-25","1234.05"`)
  })
})
