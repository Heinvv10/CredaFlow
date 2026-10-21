import { describe, expect, it } from "vitest"
import { revalue, type CurrentGuideRow, type RevaluationLoan } from "./revaluation"

const row = (over: Partial<CurrentGuideRow>): CurrentGuideRow => ({
  guideId: "g1", guideName: "TEST Plant Guide", effectiveOn: "2026-02-01", simulated: false, rowId: "r1",
  make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 100_000_000, retailCents: 120_000_000, ...over,
})
const loan = (over: Partial<RevaluationLoan>): RevaluationLoan => ({
  loanId: "l1", reference: "AF-1", contractType: "INSTALMENT_SALE", outstandingCents: 80_000_000,
  asset: { id: "a1", make: "TEST", model: "EX-1", year: 2025, serialNumber: "S1" }, lastGuide: null, ...over,
})

describe("book revaluation against the current guides", () => {
  it("values an asset on its only matching row, case and outer spaces ignored, with LTV on the outstanding balance", () => {
    const [out] = revalue([loan({ asset: { id: "a1", make: " test", model: "ex-1 ", year: 2025, serialNumber: "S1" } })], [row({}), row({ rowId: "r2", model: "EX-2" })])
    expect(out.match).toEqual({ kind: "matched", basis: "only_row", row: row({}), ltvBps: 8_000, changeCents: null })
  })

  it("keeps the variant of the asset's last guide valuation, in the guide of that name, and shows the change", () => {
    const rows = [row({}), row({ rowId: "r2", variant: "Long reach", tradeCents: 90_000_000 }), row({ guideId: "g2", guideName: "Other", rowId: "r3", variant: "Long reach" })]
    const [out] = revalue([loan({ lastGuide: { guideName: "test plant guide", variant: "LONG REACH", tradeCents: 95_000_000 } })], rows)
    expect(out.match).toMatchObject({ kind: "matched", basis: "recorded_variant", row: { rowId: "r2" }, ltvBps: 8_889, changeCents: -5_000_000 })
  })

  it("asks for a variant when several rows match and none was recorded", () => {
    const [out] = revalue([loan({})], [row({}), row({ rowId: "r2", variant: "Long reach" })])
    expect(out.match).toEqual({ kind: "ambiguous", count: 2 })
  })

  it("says so when no current row matches the asset", () => {
    const [out] = revalue([loan({ asset: { id: "a1", make: "TEST", model: "EX-1", year: 2024, serialNumber: "S1" } })], [row({})])
    expect(out.match).toEqual({ kind: "none" })
  })

  it("shows no LTV for a lease: its outstanding balance is rentals, not capital", () => {
    const [out] = revalue([loan({ contractType: "OPERATING_LEASE" }), loan({ loanId: "l2", contractType: "FULL_MAINTENANCE_LEASE" })], [row({})])
    expect(out.match).toMatchObject({ kind: "matched", ltvBps: null })
  })
})
