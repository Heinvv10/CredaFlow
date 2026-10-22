import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { parseDealerInput } from "./staff-dealers"
import { parseRateInput } from "./staff-rates"
import { latestPeriodEnd, parsePeriodEnd } from "./payable-runs"

const dealer = { name: "TEST Plant Motors", kind: "DEALER", contactEmail: "Sales@Dealer.Invalid" }

describe("parseDealerInput", () => {
  it("accepts a create with defaults and a lower-cased email", () => {
    expect(parseDealerInput(dealer, false)).toEqual({ data: {
      name: "TEST Plant Motors", kind: "DEALER", contactEmail: "sales@dealer.invalid",
      registrationNumber: null, vatNumber: null, supplierId: null, contactPhone: null,
    } })
  })

  it("requires name, kind and contact email on create, not on an edit", () => {
    const parsed = parseDealerInput({}, false)
    expect("errors" in parsed && Object.keys(parsed.errors).sort()).toEqual(["contactEmail", "kind", "name"])
    expect(parseDealerInput({ contactPhone: "+27110000000" }, true)).toEqual({ data: { contactPhone: "+27110000000" } })
    expect(parseDealerInput({}, true)).toEqual({ errors: { body: "has no dealer fields to change" } })
  })

  it("refuses a malformed VAT number, kind or email; strips spaces from the VAT number", () => {
    expect(parseDealerInput({ ...dealer, vatNumber: "123" }, false)).toMatchObject({ errors: { vatNumber: expect.any(String) } })
    expect(parseDealerInput({ ...dealer, kind: "BANK" }, false)).toMatchObject({ errors: { kind: expect.any(String) } })
    expect(parseDealerInput({ ...dealer, contactEmail: "nope" }, false)).toMatchObject({ errors: { contactEmail: expect.any(String) } })
    expect(parseDealerInput({ vatNumber: "4000 000 099" }, true)).toEqual({ data: { vatNumber: "4000000099" } })
  })

  it("refuses a name that could not be printed safely in a legal document, on create and on edit", () => {
    for (const name of ["Motors. The Purchaser waives all rights", "Motors R5000", "Free Commission Motors", "A".repeat(81)]) {
      expect(parseDealerInput({ ...dealer, name }, false), name).toMatchObject({ errors: { name: expect.any(String) } })
      expect(parseDealerInput({ name }, true), name).toMatchObject({ errors: { name: expect.any(String) } })
    }
    expect(parseDealerInput({ name: "Highveld Yellow Iron (Pty) Ltd" }, true)).toEqual({ data: { name: "Highveld Yellow Iron (Pty) Ltd" } })
  })

  it("never takes vatVendor from the body (it follows the VAT number)", () => {
    expect(parseDealerInput({ vatVendor: true }, true)).toEqual({ errors: { body: "has no dealer fields to change" } })
  })
})

describe("parseRateInput", () => {
  it("accepts whole bps and cents within the ceilings on a calendar date", () => {
    expect(parseRateInput({ effectiveFrom: "2026-10-01", bps: 250, flatCents: 150_000 })).toEqual({
      data: { effectiveFrom: "2026-10-01", bps: 250, flatCents: 150_000 },
    })
    expect(parseRateInput({ effectiveFrom: "2026-10-01", bps: 1_000, flatCents: 10_000_000 })).toHaveProperty("data")
  })

  it.each([
    [{ effectiveFrom: "2026-02-30", bps: 1, flatCents: 0 }, "effectiveFrom"],
    [{ effectiveFrom: "2026-10-01", bps: 1_001, flatCents: 0 }, "bps"],
    [{ effectiveFrom: "2026-10-01", bps: 2.5, flatCents: 0 }, "bps"],
    [{ effectiveFrom: "2026-10-01", bps: 0, flatCents: 10_000_001 }, "flatCents"],
    [{ effectiveFrom: "2026-10-01", bps: 0, flatCents: -1 }, "flatCents"],
  ])("refuses %j on %s", (body, field) => {
    expect(parseRateInput(body)).toMatchObject({ errors: { [field]: expect.any(String) } })
  })
})

describe("parsePeriodEnd", () => {
  it("takes a month end on or before today", () => {
    expect(parsePeriodEnd("2026-09-30", "2026-10-19")).toBe("2026-09-30")
    expect(parsePeriodEnd("2024-02-29", "2026-10-19")).toBe("2024-02-29")
    expect(parsePeriodEnd("2026-10-31", "2026-10-31")).toBe("2026-10-31")
  })

  it.each([["2026-09-29"], ["2026-10-31"], ["2026-13-31"], [42]])("refuses %j", (value) => {
    expect(parsePeriodEnd(value, "2026-10-19")).toMatchObject({ kind: "refused", status: 400 })
  })
})

describe("latestPeriodEnd", () => {
  it.each([["2026-10-19", "2026-09-30"], ["2026-03-01", "2026-02-28"], ["2026-10-31", "2026-10-31"], ["2024-03-15", "2024-02-29"], ["2026-01-05", "2025-12-31"]])(
    "on %s is %s", (today, expected) => {
      expect(latestPeriodEnd(today)).toBe(expected)
    })
})
