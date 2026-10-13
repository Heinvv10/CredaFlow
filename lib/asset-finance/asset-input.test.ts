import { describe, expect, it } from "vitest"
import { duplicateAssetMessage, parseAssetCreate, parseAssetUpdate, parseValuation } from "./asset-input"

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
  it("accepts a minimal asset, trims and upper-cases identifiers, defaults the optionals", () => {
    const parsed = parseAssetCreate({ ...valid, vin: " vin-test-1 " })
    expect(parsed).toEqual({
      data: expect.objectContaining({
        serialNumber: "TEST0000000000001", vin: "VIN-TEST-1", residualCents: null, lenderNotedConfirmed: false, insurer: null,
      }),
    })
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
    [{ amountCents: 0 }, "amountCents"],
    [{ valuerName: "" }, "valuerName"],
  ])("rejects %j on %s", (override, field) => {
    const parsed = parseValuation({ ...body, ...override }, "2026-10-13")
    expect("errors" in parsed && parsed.errors[field]).toBeTruthy()
  })
})

describe("duplicateAssetMessage", () => {
  it("names the serial or the VIN from Prisma's expression-index target", () => {
    expect(duplicateAssetMessage({ code: "P2002", meta: { target: ["tenantId", "upper(btrim(serialNumber))"] } })).toMatch(/serial number/)
    expect(duplicateAssetMessage({ code: "P2002", meta: { target: ["tenantId", "upper(btrim(vin))"] } })).toMatch(/VIN/)
  })

  it("leaves any other error alone", () => {
    expect(duplicateAssetMessage({ code: "P2002", meta: { target: ["tenantId", "id"] } })).toBeNull()
    expect(duplicateAssetMessage({ code: "P2003", meta: { target: ["vin"] } })).toBeNull()
    expect(duplicateAssetMessage(new Error("boom"))).toBeNull()
  })
})
