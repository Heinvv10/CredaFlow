import { describe, expect, it } from "vitest"
import { duplicateAssetMessage, parseAssetCreate, parseAssetUpdate, parseValuation, vatProblem } from "./asset-input"

const valid = {
  assetClass: "EXCAVATOR",
  make: "TEST Make",
  model: "TX-200",
  year: 2024,
  serialNumber: "  test0000000000001 ",
  cashPriceExclVatCents: 150_000_000,
  vatCents: 22_500_000,
}

describe("parseAssetCreate", () => {
  it("accepts a minimal asset, normalises identifiers, defaults the optionals", () => {
    const parsed = parseAssetCreate({ ...valid, vin: " vin-test-1 " })
    expect(parsed).toEqual({
      data: expect.objectContaining({
        serialNumber: "TEST0000000000001", vin: "VINTEST1", residualCents: null, lenderNotedConfirmed: false, insurer: null,
      }),
    })
  })

  it.each([
    ["TEST F8"], ["test-f8"], ["TEST.F8"], ["TEST/F8"], ["TEST_F8"], ["TEST\u00A0F8"], ["TEST\u2003F8"], ["  TEST F8 "],
    ["\uFF34\uFF25\uFF33\uFF34 F8"], ["TEST\u3000F8"],
  ])("stores serial %j as TESTF8, the key the duplicate checks compare (NFKC folds it to ASCII)", (serialNumber) => {
    const parsed = parseAssetCreate({ ...valid, serialNumber, vin: serialNumber })
    expect(parsed).toEqual({ data: expect.objectContaining({ serialNumber: "TESTF8", vin: "TESTF8" }) })
  })

  it.each([
    ["TEST\u2013F8"], ["TEST\u2014F8"], ["TEST\u2212F8"], ["TEST,F8"], ["TEST:F8"], ["TEST\\F8"], ["TESTF8#"], ["TEST(F8)"],
    ["\u0422EST F8"], ["TEST \u0391F8"], ["STRA\u00DFE"], ["TEST\u00C9F8"], ["TEST\u00ADF8"], ["TEST\u200BF8"], ["\uFEFFTESTF8"],
    ["TESTF8\t"], ["TESTF8\n"], ["TEST\u0007F8"], ["TEST\u202EF8"], ["\u200B - "],
  ])("refuses serial %j: a character outside A-Z, 0-9 and space - / . _ after NFKC", (serialNumber) => {
    for (const parsed of [parseAssetCreate({ ...valid, serialNumber }), parseAssetCreate({ ...valid, vin: serialNumber })]) {
      expect("errors" in parsed && (parsed.errors.serialNumber ?? parsed.errors.vin)).toMatch(/may contain only the letters A-Z, digits 0-9/)
    }
  })

  it("an identifier of separators only is required; a blank VIN is none", () => {
    expect(parseAssetCreate({ ...valid, serialNumber: " - . " })).toEqual({ errors: { serialNumber: "is required" } })
    expect(parseAssetCreate({ ...valid, vin: "  " })).toEqual({ data: expect.objectContaining({ vin: null }) })
    expect(parseAssetCreate({ ...valid, vin: " - " })).toEqual({ data: expect.objectContaining({ vin: null }) })
  })

  it.each([
    [{ assetClass: "BOAT" }, "assetClass"],
    [{ make: "   " }, "make"],
    [{ year: 1949 }, "year"],
    [{ year: 2024.5 }, "year"],
    [{ serialNumber: "" }, "serialNumber"],
    [{ cashPriceExclVatCents: 0 }, "cashPriceExclVatCents"],
    [{ cashPriceExclVatCents: 2_147_483_648 }, "cashPriceExclVatCents"],
    [{ vatCents: -1 }, "vatCents"],
    [{ vatCents: "100" }, "vatCents"],
    [{ hours: -5 }, "hours"],
    [{ residualCents: 172_500_001 }, "residualCents"],
    [{ lenderNotedConfirmed: "yes" }, "lenderNotedConfirmed"],
  ])("rejects %j on %s", (override, field) => {
    const parsed = parseAssetCreate({ ...valid, ...override })
    expect("errors" in parsed && parsed.errors[field]).toBeTruthy()
  })

  it("allows a residual equal to the price including VAT", () => {
    expect("data" in parseAssetCreate({ ...valid, residualCents: 172_500_000 })).toBe(true)
  })

  it("requires every mandatory field", () => {
    const parsed = parseAssetCreate({})
    expect("errors" in parsed && Object.keys(parsed.errors).sort()).toEqual(
      ["assetClass", "cashPriceExclVatCents", "make", "model", "serialNumber", "vatCents", "year"],
    )
  })
})

describe("parseAssetUpdate", () => {
  it("returns only the fields present; null clears an optional field", () => {
    expect(parseAssetUpdate({ insurer: "TEST Insurer", vin: null })).toEqual({ data: { insurer: "TEST Insurer", vin: null } })
  })

  it("refuses to clear a required field and an empty change", () => {
    expect(parseAssetUpdate({ serialNumber: null })).toEqual({ errors: { serialNumber: "is required" } })
    expect(parseAssetUpdate({})).toEqual({ errors: { body: "has no asset fields to change" } })
  })
})

describe("parseValuation", () => {
  const body = { valuedOn: "2026-10-01", source: "DEALER", valuerName: "TEST Valuer", amountCents: 140_000_000 }

  it("accepts a dated valuation up to today", () => {
    expect(parseValuation({ ...body, valuedOn: "2026-10-13" }, "2026-10-13")).toEqual({
      data: { ...body, valuedOn: "2026-10-13", documentId: null },
    })
  })

  it.each([
    [{ valuedOn: "2026-10-14" }, "valuedOn"],
    [{ valuedOn: "2026-02-30" }, "valuedOn"],
    [{ source: "NEIGHBOUR" }, "source"],
    // A guide value is read from a published guide (lib/valuation-guides/lookup.ts), never typed in.
    [{ source: "GUIDE" }, "source"],
    [{ amountCents: 0 }, "amountCents"],
    [{ valuerName: "" }, "valuerName"],
  ])("rejects %j on %s", (override, field) => {
    const parsed = parseValuation({ ...body, ...override }, "2026-10-13")
    expect("errors" in parsed && parsed.errors[field]).toBeTruthy()
  })
})

describe("vatProblem", () => {
  it("accepts exactly the half-up VAT on the exclusive price, and names the right figure otherwise", () => {
    expect(vatProblem(150_000_000, 22_500_000, 1500)).toBeNull()
    expect(vatProblem(3, 0, 1500)).toBeNull() // 0.45 cent rounds down
    expect(vatProblem(10, 2, 1500)).toBeNull() // 1.5 cents rounds up
    expect(vatProblem(150_000_000, 22_500_001, 1500)).toMatch(/must be 22500000 cents/)
    expect(vatProblem(10, 1, 1500)).toMatch(/must be 2 cents/)
  })
})

describe("duplicateAssetMessage", () => {
  it("names the serial or the VIN from Prisma's expression-index target", () => {
    expect(duplicateAssetMessage({ code: "P2002", meta: { target: ["tenantId", "assetIdentifierKey(serialNumber)"] } })).toMatch(/serial number/)
    expect(duplicateAssetMessage({ code: "P2002", meta: { target: ["tenantId", "assetIdentifierKey(vin)"] } })).toMatch(/VIN/)
  })

  it("reads a target-less unique violation as the cross-column check (a serial that is another asset's VIN)", () => {
    expect(duplicateAssetMessage({ code: "P2002", meta: { modelName: "FinancedAsset", target: null } })).toMatch(/serial number or VIN/)
  })

  it("leaves any other error alone", () => {
    expect(duplicateAssetMessage({ code: "P2002", meta: { target: ["tenantId", "id"] } })).toBeNull()
    expect(duplicateAssetMessage({ code: "P2003", meta: { target: ["vin"] } })).toBeNull()
    expect(duplicateAssetMessage(new Error("boom"))).toBeNull()
  })
})
