import { describe, expect, it } from "vitest"
import { revalue, type CurrentGuideRow, type RevaluationLoan } from "./revaluation"

const row = (over: Partial<CurrentGuideRow>): CurrentGuideRow => ({
  assetId: "a1", guideId: "g1", guideName: "TEST Plant Guide", effectiveOn: "2026-02-01", simulated: false, rowId: "r1",
  make: "TEST", model: "EX-1", year: 2025, variant: "", tradeCents: 100_000_000, retailCents: 120_000_000,
  recordedVariant: false, lastTradeCents: null, ...over,
})
const loan = (over: Partial<RevaluationLoan>): RevaluationLoan => ({
  loanId: "l1", reference: "AF-1", contractType: "INSTALMENT_SALE", outstandingCents: 80_000_000,
  asset: { id: "a1", make: "TEST", model: "EX-1", year: 2025, serialNumber: "S1" }, ...over,
})

// The loader's SQL matches rows to assets (PostgreSQL lower(), revaluation-store.integration.test.ts);
// revalue() picks a row per loan and computes the figures.
describe("book revaluation against the current guides", () => {
  it("values an asset on its only row, with LTV on the outstanding principal; another asset's rows are not its own", () => {
    const [out] = revalue([loan({})], [row({}), row({ assetId: "a2", rowId: "r2" })])
    expect(out.match).toEqual({ kind: "matched", basis: "only_row", row: row({}), ltvBps: 8_000, changeCents: null })
  })

  it("keeps the row the SQL flags as the recorded variant, and shows the change since that value", () => {
    const rows = [row({}), row({ rowId: "r2", variant: "Long reach", tradeCents: 90_000_000, recordedVariant: true, lastTradeCents: 95_000_000 })]
    const [out] = revalue([loan({})], rows)
    expect(out.match).toMatchObject({ kind: "matched", basis: "recorded_variant", row: { rowId: "r2" }, ltvBps: 8_889, changeCents: -5_000_000 })
  })

  it("asks for a variant when several rows match and none was recorded", () => {
    const [out] = revalue([loan({})], [row({}), row({ rowId: "r2", variant: "Long reach" })])
    expect(out.match).toEqual({ kind: "ambiguous", count: 2 })
  })

  it("says so when no current row matches the asset", () => {
    const [out] = revalue([loan({})], [row({ assetId: "a2" })])
    expect(out.match).toEqual({ kind: "none" })
  })

  it("shows no LTV for an operating or a full-maintenance lease: its outstanding balance is rentals, not capital", () => {
    const out = revalue([loan({ contractType: "OPERATING_LEASE" }), loan({ loanId: "l2", contractType: "FULL_MAINTENANCE_LEASE" })], [row({})])
    expect(out.map((r) => r.match)).toEqual([expect.objectContaining({ kind: "matched", ltvBps: null }), expect.objectContaining({ kind: "matched", ltvBps: null })])
  })
})
