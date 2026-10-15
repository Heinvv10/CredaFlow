import { describe, expect, it } from "vitest"
import { COST_ENTRY, costDecisionSubmission, costSubmission, emptyCostForm } from "./recovery-cost-adapter"
import { emptyRecordForm, emptyValuationForm, recordRecoveryBody, valuationBody } from "./recovery-forms"

describe("valuationBody", () => {
  const ok = { ...emptyValuationForm("2026-10-15"), valuerName: " TEST Valuers ", amount: "R850,000.50" }
  it("sends the amount as integer cents", () => {
    expect(valuationBody(ok)).toEqual({ body: { valuedOn: "2026-10-15", source: "ASSESSOR", valuerName: "TEST Valuers", amountCents: 85_000_050 } })
  })
  it("asks for the valuer and a positive amount", () => {
    expect(valuationBody({ ...ok, valuerName: " " })).toMatchObject({ error: expect.stringMatching(/valuer/) })
    expect(valuationBody({ ...ok, amount: "0" })).toMatchObject({ error: expect.stringMatching(/rand/) })
    expect(valuationBody({ ...ok, amount: "12.345" })).toMatchObject({ error: expect.stringMatching(/rand/) })
  })
})

describe("recordRecoveryBody", () => {
  const form = { ...emptyRecordForm("2026-10-15"), location: "Yard 4", condition: "Good" }
  it("opens a non-NCA hand-over without a surrender and carries a lease's meter reading", () => {
    expect(recordRecoveryBody("NON_NCA_VOLUNTARY", { ...form, meterReading: "1 250" })).toEqual({
      body: { route: "NON_NCA_VOLUNTARY", recoveredOn: "2026-10-15", location: "Yard 4", condition: "Good", meterReading: { value: 1250 } },
    })
  })
  it("names the surrender for an s127 recovery and refuses without one", () => {
    expect(recordRecoveryBody("NCA_S127_SURRENDER", form)).toMatchObject({ error: expect.stringMatching(/surrender/) })
    expect(recordRecoveryBody("NCA_S127_SURRENDER", { ...form, surrenderRequestId: "s-1" })).toMatchObject({ body: { surrenderRequestId: "s-1" } })
  })
  it("asks for the location, the condition and a whole-number reading", () => {
    expect(recordRecoveryBody("NON_NCA_VOLUNTARY", { ...form, location: "" })).toMatchObject({ error: expect.stringMatching(/location/) })
    expect(recordRecoveryBody("NON_NCA_VOLUNTARY", { ...form, condition: "" })).toMatchObject({ error: expect.stringMatching(/condition/) })
    expect(recordRecoveryBody("NON_NCA_VOLUNTARY", { ...form, meterReading: "12.5" })).toMatchObject({ error: expect.stringMatching(/whole number/) })
  })
})

describe("costSubmission (the cost-entry adapter)", () => {
  const form = { ...emptyCostForm("2026-10-15", "TOWING", "DEDUCT_FROM_PROCEEDS"), net: "1250", vat: "187.50", supplierInvoiceRef: "INV-1" }
  it("posts cents to the recovery's costs route", () => {
    expect(costSubmission("rec-1", form)).toEqual({
      url: "/api/asset-finance/recoveries/rec-1/costs",
      body: { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", netCents: 125_000, vatCents: 18_750, supplierInvoiceRef: "INV-1", incurredOn: "2026-10-15" },
    })
  })
  it("asks for what the route would refuse", () => {
    expect(costSubmission("rec-1", { ...form, net: "abc" })).toMatchObject({ error: expect.stringMatching(/net amount/) })
    expect(costSubmission("rec-1", { ...form, net: "0", vat: "0" })).toMatchObject({ error: expect.stringMatching(/more than nil/) })
    expect(costSubmission("rec-1", { ...form, supplierInvoiceRef: " " })).toMatchObject({ error: expect.stringMatching(/invoice reference/) })
    expect(costSubmission("rec-1", { ...form, type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT" })).toMatchObject({ error: expect.stringMatching(/judgment or settlement/) })
    expect(costSubmission("rec-1", { ...form, type: "LEGAL_TAXED", treatment: "CHARGE_TO_ACCOUNT", legalStepId: "s-1" })).toMatchObject({ body: { legalStepId: "s-1" } })
  })
})

describe("cost decisions", () => {
  it("posts the decision to the cost's decide route", () => {
    expect(costDecisionSubmission("rec-1", "c-1", "REJECTED")).toEqual({ url: "/api/asset-finance/recoveries/rec-1/costs/c-1/decide", body: { decision: "REJECTED" } })
  })
  it("lets an approver decide a cost only when someone else recorded it", () => {
    expect(COST_ENTRY.canDecide({ canDecide: true }, "u-2", "u-1")).toBe(true)
    expect(COST_ENTRY.canDecide({ canDecide: true }, "u-1", "u-1")).toBe(false)
    expect(COST_ENTRY.canDecide({ canDecide: false }, "u-2", "u-1")).toBe(false)
  })
  it("lets a manager enter a cost and nobody else", () => {
    expect(COST_ENTRY.canEnter({ canManage: true })).toBe(true)
    expect(COST_ENTRY.canEnter({ canManage: false })).toBe(false)
  })
})
