import { describe, expect, it } from "vitest"
import { escalationWeights, maintenanceCharges, priceLease, type LeasePricingInput } from "./lease-pricing"
import { oraclePeriods, oracleRealBase, oracleWeights, type OracleLease } from "./__tests__/lease-oracle"

const VAT = 1500

function input(overrides: Partial<LeasePricingInput> = {}): LeasePricingInput {
  return {
    cashPriceExclVatCents: 100_000_000,
    residualCents: 0,
    periods: 12,
    rentalTiming: "ARREARS",
    escalationRate: "0",
    startDate: "2027-01-15",
    ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0 }],
    maintenance: null,
    vatRateTenThousandths: VAT,
    ...overrides,
  }
}

function toOracle(i: LeasePricingInput): OracleLease {
  return {
    capitalCents: i.cashPriceExclVatCents,
    residualCents: i.residualCents,
    periods: i.periods,
    timing: i.rentalTiming,
    escalation: i.escalationRate,
    startDate: i.startDate,
    firstDueDate: i.firstDueDate,
    annualRate: i.ratePath[0].annualRate,
    maintenanceCents: i.maintenance?.monthlyExclVatCents ?? null,
    maintenanceEscalation: i.maintenance?.escalationRate ?? "0",
    vatTenThousandths: i.vatRateTenThousandths,
  }
}

function expectOracle(i: LeasePricingInput): void {
  const result = priceLease(i)
  const lease = toOracle(i)
  expect(result.weights).toEqual(oracleWeights(lease))
  expect(Math.abs(result.baseRentalCents - oracleRealBase(lease))).toBeLessThanOrEqual(0.5 + 1e-6)
  const oracle = oraclePeriods(lease, result.baseRentalCents)
  expect(result.periods.map((p) => ({
    dueDate: p.dueDate, rental: p.rentalExclVatCents, maintenance: p.maintenanceExclVatCents, vat: p.vatCents, total: p.totalCents,
  }))).toEqual(oracle)
  const last = result.periods[result.periods.length - 1].row
  expect(last.closingBalanceCents + last.balloonCents).toBe(i.residualCents)
}

describe("priceLease: worked examples", () => {
  it("12 rentals in arrears at 0%: equal rentals, the last absorbs the residue, VAT per line", () => {
    const r = priceLease(input())
    expect(r.baseRentalCents).toBe(8_333_333)
    expect(r.periods.map((p) => p.rentalExclVatCents)).toEqual([...Array(11).fill(8_333_333), 8_333_337])
    expect(r.periods[0]).toMatchObject({ dueDate: "2027-02-15", vatCents: 1_250_000, totalCents: 9_583_333 })
    expect(r.periods[11]).toMatchObject({ dueDate: "2028-01-15", vatCents: 1_250_001, totalCents: 9_583_338 })
    expect(r.totalRentalExclVatCents).toBe(100_000_000)
  })

  it("ADVANCE: the first rental falls due on the commencement date and carries no finance charge", () => {
    const r = priceLease(input({ rentalTiming: "ADVANCE", ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.12 }] }))
    expect(r.periods[0].dueDate).toBe("2027-01-15")
    expect(r.periods[0].row.interestCents).toBe(0)
    expect(r.periods[11].dueDate).toBe("2027-12-15")
    // An annuity due repays the same capital with smaller rentals than arrears.
    const arrears = priceLease(input({ ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.12 }] }))
    expect(r.baseRentalCents).toBeLessThan(arrears.baseRentalCents)
  })

  it("escalates the rental once a year, compounded", () => {
    expect(escalationWeights(26, "0.1")).toEqual([...Array(12).fill(1), ...Array(12).fill(1.1), 1.21, 1.21])
    const r = priceLease(input({ periods: 24, escalationRate: "0.1" }))
    // 12B + 12(1.1B) = 1,000,000.00 → B = 39,682.54 (0% rate)
    expect(r.baseRentalCents).toBe(3_968_254)
    expect(r.periods[12].rentalExclVatCents).toBe(4_365_079) // round(3,968,254 × 1.1) = 4,365,079.4
  })

  it("rounds escalation factors half-up to six decimals", () => {
    // 1.0825^2 = 1.17180625 → 1.171806; 1.0825^3 = 1.268480265625 → 1.268480
    expect(escalationWeights(37, "0.0825").slice(24, 25)).toEqual([1.171806])
    expect(escalationWeights(37, "0.0825")[36]).toBe(1.268480)
  })

  it("FML: a separate maintenance line with its own escalation, VAT per line", () => {
    expect(maintenanceCharges(13, { monthlyExclVatCents: 333_333, escalationRate: "0.065" })).toEqual([
      ...Array(12).fill(333_333), 355_000, // 333,333 × 1.065 = 354,999.645 → 355,000
    ])
    const r = priceLease(input({ maintenance: { monthlyExclVatCents: 333_333, escalationRate: "0.065" } }))
    // VAT on 8,333,333 is 1,250,000 (1,249,999.95); on 333,333 it is 50,000 (49,999.95)
    expect(r.periods[0]).toMatchObject({ maintenanceExclVatCents: 333_333, vatCents: 1_300_000, totalCents: 9_966_666 })
    expect(r.totalMaintenanceExclVatCents).toBe(12 * 333_333)
  })

  it("the residual stays with the lender: the capital balance after the last rental is the residual", () => {
    const r = priceLease(input({ residualCents: 30_000_000, ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.115 }] }))
    const last = r.periods[11].row
    expect(last.openingBalanceCents + last.interestCents - r.periods[11].rentalExclVatCents).toBe(30_000_000)
    expect(r.totalCents).toBe(r.totalRentalExclVatCents + r.totalVatCents)
  })

  it("refuses bad input", () => {
    expect(() => priceLease(input({ residualCents: 100_000_000 }))).toThrow(RangeError)
    expect(() => priceLease(input({ escalationRate: "1" }))).toThrow(/below 1/)
    expect(() => priceLease(input({ escalationRate: "0.1234567" }))).toThrow(/6 places/)
    expect(() => priceLease(input({ rentalTiming: "ADVANCE", firstDueDate: "2027-02-15" }))).toThrow(/commencement/)
    expect(() => priceLease(input({ firstDueDate: "2027-01-15" }))).toThrow(/after startDate/)
    expect(() => priceLease(input({ maintenance: { monthlyExclVatCents: 0, escalationRate: "0" } }))).toThrow(RangeError)
  })
})

describe("priceLease agrees with the independent oracle to the cent", () => {
  const cases: Array<[string, Partial<LeasePricingInput>]> = [
    ["arrears", { periods: 36, residualCents: 25_000_000, ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.1175 }] }],
    ["advance", { periods: 36, rentalTiming: "ADVANCE", residualCents: 25_000_000, ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.1175 }] }],
    ["arrears + escalation", { periods: 60, escalationRate: "0.08", residualCents: 15_000_000, ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.13 }] }],
    ["advance + escalation + FML", {
      periods: 48, rentalTiming: "ADVANCE", escalationRate: "0.065", residualCents: 20_000_000,
      ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.1225 }], maintenance: { monthlyExclVatCents: 455_000, escalationRate: "0.07" },
    }],
    ["first due 31st, month-end clamping", { periods: 14, startDate: "2027-01-10", firstDueDate: "2027-01-31", ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.105 }] }],
  ]
  it.each(cases)("%s", (_, overrides) => expectOracle(input(overrides)))

  it("property: 150 seeded random leases", () => {
    let s = 20261014
    const rnd = () => {
      s = (s * 1103515245 + 12345) % 2147483648
      return s / 2147483648
    }
    const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1))
    for (let k = 0; k < 150; k++) {
      const price = int(5_000_000, 600_000_000)
      const n = int(1, 84)
      const fml = rnd() < 0.5
      expectOracle(input({
        cashPriceExclVatCents: price,
        residualCents: Math.floor(price * rnd() * 0.5),
        periods: n,
        rentalTiming: rnd() < 0.5 ? "ADVANCE" : "ARREARS",
        escalationRate: (int(0, 150) / 1000).toString(),
        startDate: `20${int(27, 30)}-${String(int(1, 12)).padStart(2, "0")}-${String(int(1, 28)).padStart(2, "0")}`,
        ratePath: [{ effectiveDate: "2026-01-01", annualRate: int(0, 250_000) / 1_000_000 }],
        maintenance: fml ? { monthlyExclVatCents: int(10_000, 2_000_000), escalationRate: (int(0, 120) / 1000).toString() } : null,
      }))
    }
  }, 60_000)
})
