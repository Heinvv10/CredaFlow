import { describe, expect, it } from "vitest"
import { parseDealPreview } from "./deal-input"
import type { DealFormValues } from "./deal-form-body"
import { LEASE_INITIAL, leaseDealBody, type LeaseFormValues } from "./lease-form-body"

const base: DealFormValues = {
  assetId: "asset-1", contractType: "INSTALMENT_SALE", depositRands: "5000", tradeInRands: "1000", feesRands: "250", balloonRands: "100000",
  firstDueDate: "2030-02-01", vatDeferralPeriod: "2", rateBasis: "FIXED", ratePercent: "12.5", preset: "STEP_UP", periods: "36", skipFirst: "",
  seasonMonths: "", seasonWeight: "", offWeight: "", months: "", steps: "13:1.5",
}
const operating: LeaseFormValues = { ...LEASE_INITIAL, penaltyPercent: "10", escalationPercent: "8" }
const maintenance: LeaseFormValues = {
  ...operating, rentalTiming: "ADVANCE", maintenanceRands: "2500.50", maintenanceEscalationPercent: "6", riskModel: "LESSEE_SETTLED",
  usageAllowance: "1200", usageUnit: "KM", excessRateRands: "4.50",
}

describe("leaseDealBody", () => {
  it("builds an operating lease body with no deposit, trade-in, fee, deferral or non-monthly preset", () => {
    const { body, errors } = leaseDealBody(base, operating, "OPERATING_LEASE")
    expect(errors).toEqual({})
    expect(body).toMatchObject({
      assetId: "asset-1", contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
      balloonCents: 10_000_000, fixedRate: "0.125", preset: { kind: "MONTHLY", periods: 36 },
    })
    for (const key of ["depositCents", "tradeInCents", "financedFeesCents", "vatDeferralPeriodIndex", "maintenanceRiskModel", "usageUnit"]) {
      expect(body).not.toHaveProperty(key)
    }
  })

  it("builds a full-maintenance body with maintenance and usage in cents", () => {
    const { body, errors } = leaseDealBody(base, maintenance, "FULL_MAINTENANCE_LEASE")
    expect(errors).toEqual({})
    expect(body).toMatchObject({
      contractType: "FULL_MAINTENANCE_LEASE", rentalTiming: "ADVANCE", maintenanceMonthlyExclVatCents: 250_050, maintenanceEscalationRate: "0.06",
      maintenanceRiskModel: "LESSEE_SETTLED", usageAllowancePerYear: 1200, usageUnit: "KM", excessRateCents: 450,
    })
  })

  it("is accepted by the deal API's own parser, operating and full-maintenance", () => {
    for (const [values, type] of [[operating, "OPERATING_LEASE"], [maintenance, "FULL_MAINTENANCE_LEASE"]] as const) {
      const { body } = leaseDealBody(base, values, type)
      const parsed = parseDealPreview(body, "2030-01-01")
      expect("errors" in parsed ? parsed.errors : null).toBeNull()
    }
  })

  it("requires the penalty, and on a full-maintenance lease the maintenance and usage", () => {
    expect(Object.keys(leaseDealBody(base, LEASE_INITIAL, "OPERATING_LEASE").errors)).toEqual(["earlyTerminationPenaltyRate"])
    expect(Object.keys(leaseDealBody(base, operating, "FULL_MAINTENANCE_LEASE").errors).sort()).toEqual([
      "excessRateCents", "maintenanceEscalationRate", "maintenanceMonthlyExclVatCents", "usageAllowancePerYear",
    ])
  })

  it("treats usage on an operating lease as all of it or none", () => {
    expect(leaseDealBody(base, operating, "OPERATING_LEASE").body).not.toHaveProperty("usageAllowancePerYear")
    const half = leaseDealBody(base, { ...operating, usageAllowance: "900" }, "OPERATING_LEASE")
    expect(Object.keys(half.errors)).toEqual(["excessRateCents"])
    expect(Object.keys(leaseDealBody(base, { ...operating, excessRateRands: "3" }, "OPERATING_LEASE").errors)).toEqual(["usageAllowancePerYear"])
  })

  it("rejects malformed rates and amounts under the API's field names", () => {
    const { errors } = leaseDealBody(base, { ...maintenance, escalationPercent: "abc", maintenanceRands: "0", usageAllowance: "1.5" }, "FULL_MAINTENANCE_LEASE")
    expect(Object.keys(errors).sort()).toEqual(["escalationRate", "maintenanceMonthlyExclVatCents", "usageAllowancePerYear"])
  })

  it("keeps the rate error of the shared rate field", () => {
    expect(leaseDealBody({ ...base, ratePercent: "x" }, operating, "OPERATING_LEASE").errors).toHaveProperty("fixedRate")
  })
})
