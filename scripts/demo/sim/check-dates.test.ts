import { describe, expect, it } from "vitest"
import { isBusinessDateColumn } from "./check-dates"

describe("isBusinessDateColumn", () => {
  it.each([
    ["StatementAnalysis", "periodStart"],
    ["StatementAnalysis", "periodEnd"],
    ["BankStatementImport", "periodStart"],
    ["BankStatementImport", "periodEnd"],
    ["ReferenceRate", "effectiveDate"],
    ["ContractRate", "effectiveDate"],
    ["VatRate", "effectiveDate"],
    ["LeaseTerminationQuote", "terminationDate"],
    ["MaintenanceFund", "leaseEndDate"],
  ])("excludes %s.%s from event-clock leak detection", (table, column) => {
    expect(isBusinessDateColumn(table, column)).toBe(true)
  })

  it("keeps event timestamps and unrelated effective dates under audit", () => {
    expect(isBusinessDateColumn("ReferenceRate", "createdAt")).toBe(false)
    expect(isBusinessDateColumn("InsuranceQuote", "effectiveDate")).toBe(false)
  })
})
