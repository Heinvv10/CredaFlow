import { describe, expect, it } from "vitest"
import { parseDealCreate, parseDealPreview } from "./deal-input"

const TODAY = "2026-10-13"
const base = {
  assetId: "asset-1",
  contractType: "INSTALMENT_SALE",
  depositCents: 1_000_000,
  firstDueDate: "2026-11-30",
  preset: { kind: "MONTHLY", periods: 12 },
  rateBasis: "PRIME",
  rateMargin: "0.0150",
}
const errorsOf = (body: unknown) => {
  const result = parseDealPreview(body, TODAY)
  return "errors" in result ? result.errors : {}
}

describe("parseDealPreview", () => {
  it("parses a prime-linked monthly structure with defaults of 0", () => {
    const result = parseDealPreview(base, TODAY)
    expect(result).toEqual({
      data: {
        assetId: "asset-1",
        contractType: "INSTALMENT_SALE",
        nca: false,
        terms: {
          depositCents: 1_000_000, tradeInCents: 0, financedFeesCents: 0, balloonCents: 0,
          preset: "MONTHLY", weights: new Array(12).fill(1), firstDueDate: "2026-11-30", vatDeferralPeriodIndex: null,
          rate: { basis: "PRIME", margin: "0.0150", fixedRate: null },
        },
      },
    })
  })

  it("generates calendar presets from the first due date's month", () => {
    // First due in November: Nov Dec Jan Feb Mar Apr → the Mar/Apr harvest months carry weight 3.
    const result = parseDealPreview({
      ...base, preset: { kind: "ANNUAL_SEASONAL", periods: 6, seasonMonths: [3, 4], seasonWeight: 3, offWeight: 0.5 },
    }, TODAY)
    expect("data" in result && result.data.terms.weights).toEqual([0.5, 0.5, 0.5, 0.5, 3, 3])
  })

  it.each([
    [{ rateBasis: "FIXED", rateMargin: undefined }, "fixedRate"],
    [{ rateBasis: "FIXED", rateMargin: "0.01", fixedRate: "0.12" }, "rateMargin"],
    [{ rateMargin: undefined }, "rateMargin"],
    [{ rateMargin: "1.5" }, "rateMargin"],
    [{ fixedRate: "0.12" }, "fixedRate"],
    [{ rateBasis: "LIBOR" }, "rateBasis"],
    [{ firstDueDate: TODAY }, "firstDueDate"],
    [{ firstDueDate: "2026-02-30" }, "firstDueDate"],
    [{ depositCents: -1 }, "depositCents"],
    [{ balloonCents: 1.5 }, "balloonCents"],
    [{ preset: { kind: "MONTHLY", periods: 121 } }, "preset.periods"],
    [{ preset: { kind: "WEEKLY", periods: 12 } }, "preset.kind"],
    [{ preset: { kind: "SKIP_N", periods: 12, skipFirst: 12 } }, "preset"],
    [{ preset: { kind: "BIANNUAL", periods: 12, months: [3] } }, "preset.months"],
    [{ assetId: "" }, "assetId"],
    [{ vatDeferralPeriodIndex: 2 }, "vatDeferralPeriodIndex"], // reference-linked: no VAT deferral in slice 1
  ])("refuses %j on %s", (override, field) => {
    expect(errorsOf({ ...base, ...override })).toHaveProperty(field)
  })

  it("allows VAT deferral on a fixed rate", () => {
    const result = parseDealPreview({ ...base, rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.13", vatDeferralPeriodIndex: 2 }, TODAY)
    expect("data" in result && result.data.terms.vatDeferralPeriodIndex).toBe(2)
  })

  it("accepts a negative margin (prime minus) and a fixed rate", () => {
    expect(errorsOf({ ...base, rateMargin: "-0.0050" })).toEqual({})
    expect(errorsOf({ ...base, rateBasis: "FIXED", rateMargin: undefined, fixedRate: "0.1350" })).toEqual({})
  })
})

describe("parseDealCreate", () => {
  it("needs exactly one borrower, plus supplier and product", () => {
    const result = parseDealCreate(base, TODAY)
    expect("errors" in result && Object.keys(result.errors).sort()).toEqual(["borrower", "productId", "supplierId"])
    const ok = parseDealCreate({ ...base, entityId: "e", supplierId: "s", productId: "p" }, TODAY)
    expect("data" in ok && ok.data).toMatchObject({ entityId: "e", supplierId: "s", productId: "p", assetId: "asset-1" })
    const soleProprietor = parseDealCreate({ ...base, clientId: "c", supplierId: "s", productId: "p", contractType: "FINANCE_LEASE" }, TODAY)
    expect("data" in soleProprietor && soleProprietor.data).toMatchObject({ clientId: "c", entityId: null, contractType: "FINANCE_LEASE" })
    const both = parseDealCreate({ ...base, clientId: "c", entityId: "e", supplierId: "s", productId: "p" }, TODAY)
    expect("errors" in both && both.errors).toHaveProperty("borrower")
  })
})
