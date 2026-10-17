import { expect, it } from "vitest"
import { LEASE_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-lease-deals"
import { loanSources } from "./sources"
it("a credited maintenance contribution reverses the income/liability reclassification without inventing a bank refund", () => {
  const loan = LEASE_JOURNAL_DEALS.find((d) => d.loan.assetFinance?.fund?.riskModel === "LESSEE_SETTLED")!.loan
  const changed = { ...loan, assetFinance: { ...loan.assetFinance!, fund: { riskModel: "LESSEE_SETTLED" as const, movements: [{ id: "credit-1", kind: "CONTRIBUTION_CREDIT" as const, amountCents: 500, occurredOn: new Date("2026-10-17T00:00:00Z") }] } } }
  const source = loanSources(changed, new Date("2026-11-01T00:00:00Z")).find((s) => s.baseKey === "mf:credit-1")!
  expect(source.vector).toEqual({ MAINTENANCE_INCOME: -500, MAINTENANCE_FUND_LIABILITY: 500 })
})
