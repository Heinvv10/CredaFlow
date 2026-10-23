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
    ["LeaseTerminationQuote", "validUntil"],
    ["MaintenanceFund", "leaseEndDate"],
    ["Recovery", "chargesFrozenUntil"],
    ["DealerCommissionRate", "effectiveFrom"],
  ])("excludes %s.%s from event-clock leak detection", (table, column) => {
    expect(isBusinessDateColumn(table, column)).toBe(true)
  })

  it("keeps event timestamps and unrelated effective dates under audit", () => {
    expect(isBusinessDateColumn("ReferenceRate", "createdAt")).toBe(false)
    expect(isBusinessDateColumn("InsuranceQuote", "effectiveDate")).toBe(false)
    // The event stamps beside the lease exemptions still catch a leaked clock.
    expect(isBusinessDateColumn("LeaseTerminationQuote", "quotedOn")).toBe(false)
    expect(isBusinessDateColumn("MaintenanceFund", "createdAt")).toBe(false)
    expect(isBusinessDateColumn("Recovery", "proceedsAppliedAt")).toBe(false)
    expect(isBusinessDateColumn("Recovery", "updatedAt")).toBe(false)
    expect(isBusinessDateColumn("Payment", "chargesFrozenUntil")).toBe(false)
    expect(isBusinessDateColumn("DealerCommissionRate", "createdAt")).toBe(false)
    expect(isBusinessDateColumn("DealerCommissionLine", "effectiveOn")).toBe(false)
  })
})
