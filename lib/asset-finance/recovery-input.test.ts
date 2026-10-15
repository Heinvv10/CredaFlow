import { describe, expect, it } from "vitest"
import { parseCost, parseCostDecision, parseCreateRecovery } from "./recovery-input"

const create = { route: "NON_NCA_VOLUNTARY", recoveredOn: "2026-10-15", location: "TEST Yard", condition: "Synthetic: fair" }
const cost = {
  type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 10_000, vatCents: 1_500, supplierInvoiceRef: "INV-1", incurredOn: "2026-10-15"
}

describe("parseCreateRecovery", () => {
  it("takes a plain voluntary recovery and trims its text", () => {
    expect(parseCreateRecovery({ ...create, location: "  TEST Yard  " })).toEqual({ data: {
      route: "NON_NCA_VOLUNTARY", recoveredOn: "2026-10-15", location: "TEST Yard", condition: "Synthetic: fair",
      surrenderRequestId: null, legalMatterId: null, meterReading: undefined,
    } })
  })

  it("carries the surrender, the legal matter and an inspection reading", () => {
    const parsed = parseCreateRecovery({ ...create, route: "NCA_S127_SURRENDER", surrenderRequestId: "s1", legalMatterId: "m1", meterReading: { value: 1200, readingDate: "2026-10-14" } })
    expect(parsed).toMatchObject({ data: { surrenderRequestId: "s1", legalMatterId: "m1", meterReading: { value: 1200, readingDate: "2026-10-14" } } })
  })

  it.each([
    [{ ...create, route: "SELL_IT" }, "route"],
    [{ ...create, recoveredOn: "15/10/2026" }, "recoveredOn"],
    [{ ...create, location: "x" }, "location"],
    [{ ...create, condition: "  " }, "condition"],
    [{ ...create, meterReading: { value: 1.5 } }, "meterReading"],
    [{ ...create, meterReading: { value: 10, readingDate: "yesterday" } }, "meterReading"],
  ])("reports %j", (body, field) => {
    expect(parseCreateRecovery(body)).toMatchObject({ errors: { [field]: expect.any(String) } })
  })

  it("refuses a body that is not an object", () => {
    expect(parseCreateRecovery(null)).toEqual({ errors: { body: "must be a JSON object" } })
    expect(parseCreateRecovery([create])).toEqual({ errors: { body: "must be a JSON object" } })
  })
})

describe("parseCost", () => {
  it("parses a cost and defaults the optionals", () => {
    expect(parseCost(cost)).toEqual({ data: {
      type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 10_000, vatCents: 1_500, supplierId: null, supplierInvoiceRef: "INV-1",
      incurredOn: "2026-10-15", legalStepId: null, note: null,
    } })
  })

  it.each([
    [{ ...cost, type: "BRIBES" }, "type"],
    [{ ...cost, treatment: "ABSORB" }, "treatment"],
    [{ ...cost, netCents: -1 }, "netCents"],
    [{ ...cost, netCents: 10.5 }, "netCents"],
    [{ ...cost, vatCents: "1500" }, "vatCents"],
    [{ ...cost, supplierInvoiceRef: " " }, "supplierInvoiceRef"],
    [{ ...cost, incurredOn: "2026-13-45x" }, "incurredOn"],
  ])("reports %j", (body, field) => {
    expect(parseCost(body)).toMatchObject({ errors: { [field]: expect.any(String) } })
  })
})

describe("parseCostDecision", () => {
  it("takes APPROVED and REJECTED only", () => {
    expect(parseCostDecision({ decision: "APPROVED" })).toEqual({ data: { decision: "APPROVED" } })
    expect(parseCostDecision({ decision: "REJECTED" })).toEqual({ data: { decision: "REJECTED" } })
    expect(parseCostDecision({ decision: "PENDING" })).toMatchObject({ errors: { decision: expect.any(String) } })
    expect(parseCostDecision(null)).toMatchObject({ errors: { decision: expect.any(String) } })
  })
})
