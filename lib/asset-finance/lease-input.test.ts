import { describe, expect, it } from "vitest"
import { parseDealCreate, parseDealPreview } from "./deal-input"

const TODAY = "2026-10-13"
const operating = {
  assetId: "asset-1",
  contractType: "OPERATING_LEASE",
  balloonCents: 30_000_000,
  firstDueDate: "2026-11-30",
  preset: { kind: "MONTHLY", periods: 26 },
  rateBasis: "FIXED",
  fixedRate: "0.125",
  rentalTiming: "ARREARS",
  escalationRate: "0.08",
  earlyTerminationPenaltyRate: "0.1",
}
const fml = {
  ...operating,
  contractType: "FULL_MAINTENANCE_LEASE",
  maintenanceMonthlyExclVatCents: 450_000,
  maintenanceEscalationRate: "0.065",
  maintenanceRiskModel: "LESSEE_SETTLED",
  usageAllowancePerYear: 1_500,
  usageUnit: "HOURS",
  excessRateCents: 35_000,
}
const errorsOf = (body: unknown) => {
  const result = parseDealPreview(body, TODAY)
  return "errors" in result ? result.errors : {}
}

describe("parseDealPreview: leases", () => {
  it("parses an operating lease: escalation weights, the residual as the balloon, no maintenance", () => {
    const result = parseDealPreview(operating, TODAY)
    if (!("data" in result)) throw new Error(JSON.stringify(result.errors))
    expect(result.data.contractType).toBe("OPERATING_LEASE")
    expect(result.data.terms.weights).toEqual([...Array(12).fill(1), ...Array(12).fill(1.08), 1.1664, 1.1664])
    expect(result.data.terms.balloonCents).toBe(30_000_000)
    expect(result.data.terms.lease).toEqual({
      rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1", maintenance: null, usage: null,
    })
  })

  it("parses a full-maintenance lease with maintenance and usage", () => {
    const result = parseDealPreview(fml, TODAY)
    if (!("data" in result)) throw new Error(JSON.stringify(result.errors))
    expect(result.data.terms.lease).toEqual({
      rentalTiming: "ARREARS", escalationRate: "0.08", earlyTerminationPenaltyRate: "0.1",
      maintenance: { monthlyExclVatCents: 450_000, escalationRate: "0.065", riskModel: "LESSEE_SETTLED" },
      usage: { allowancePerYear: 1_500, unit: "HOURS", excessRateCents: 35_000 },
    })
  })

  it("an operating lease may carry contracted usage, all three fields or none", () => {
    const result = parseDealPreview({ ...operating, usageAllowancePerYear: 30_000, usageUnit: "KM", excessRateCents: 250 }, TODAY)
    expect("data" in result && result.data.terms.lease?.usage).toEqual({ allowancePerYear: 30_000, unit: "KM", excessRateCents: 250 })
    expect(errorsOf({ ...operating, usageUnit: "KM" })).toHaveProperty("usageAllowancePerYear")
  })

  it("escalation defaults to 0", () => {
    const result = parseDealPreview({ ...operating, escalationRate: undefined }, TODAY)
    expect("data" in result && result.data.terms.weights.every((w) => w === 1)).toBe(true)
  })

  it.each<[Record<string, unknown>, string]>([
    [{ ...operating, depositCents: 100 }, "depositCents"],
    [{ ...operating, tradeInCents: 100 }, "tradeInCents"],
    [{ ...operating, financedFeesCents: 100 }, "financedFeesCents"],
    [{ ...operating, rateBasis: "FIXED", vatDeferralPeriodIndex: 1 }, "vatDeferralPeriodIndex"],
    [{ ...operating, preset: { kind: "SKIP_N", periods: 12, skipFirst: 2 } }, "preset.kind"],
    [{ ...operating, rentalTiming: undefined }, "rentalTiming"],
    [{ ...operating, rentalTiming: "QUARTERLY" }, "rentalTiming"],
    [{ ...operating, escalationRate: "1" }, "escalationRate"],
    [{ ...operating, escalationRate: "0.1234567" }, "escalationRate"],
    [{ ...operating, earlyTerminationPenaltyRate: undefined }, "earlyTerminationPenaltyRate"],
    [{ ...operating, maintenanceMonthlyExclVatCents: 1 }, "maintenanceMonthlyExclVatCents"],
    [{ ...fml, maintenanceMonthlyExclVatCents: undefined }, "maintenanceMonthlyExclVatCents"],
    [{ ...fml, maintenanceEscalationRate: undefined }, "maintenanceEscalationRate"],
    [{ ...fml, maintenanceRiskModel: "SHARED" }, "maintenanceRiskModel"],
    [{ ...fml, usageAllowancePerYear: undefined, usageUnit: undefined, excessRateCents: undefined }, "usageAllowancePerYear"],
    [{ ...fml, usageUnit: "MILES" }, "usageUnit"],
    [{ ...fml, excessRateCents: 0 }, "excessRateCents"],
  ])("refuses %j on %s", (body, field) => {
    expect(errorsOf(body)).toHaveProperty(field)
  })

  it("accepts a lease for an entity or a sole proprietor (Client)", () => {
    const parties = { supplierId: "s1", productId: "p1" }
    const entity = parseDealCreate({ ...fml, ...parties, entityId: "e1" }, TODAY)
    const client = parseDealCreate({ ...operating, ...parties, clientId: "c1" }, TODAY)
    expect("data" in entity && entity.data.entityId).toBe("e1")
    expect("data" in client && client.data.clientId).toBe("c1")
  })
})
