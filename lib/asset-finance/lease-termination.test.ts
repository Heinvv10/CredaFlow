import { describe, expect, it } from "vitest"
import { cpaCancellationDate, earlyTerminationAmount, presentValueOfRentals } from "./lease-termination"

const rentals = (n: number, first: string, cents: number) => Array.from({ length: n }, (_, i) => {
  const d = new Date(`${first}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + i)
  return { dueDate: d.toISOString().slice(0, 10), rentalExclVatCents: cents }
})

// Independent: walk every day from the termination date, compounding the
// discount factor at each due date with that period's simple day count.
function oraclePv(rows: { dueDate: string; rentalExclVatCents: number }[], from: string, rate: number): number {
  let factor = 1
  let previous = Date.parse(`${from}T00:00:00Z`)
  let pv = 0
  for (const r of rows.filter((x) => x.dueDate > from)) {
    const due = Date.parse(`${r.dueDate}T00:00:00Z`)
    let days = 0
    for (let t = previous + 86_400_000; t <= due; t += 86_400_000) days++
    factor *= 1 + (rate * days) / 365
    pv += r.rentalExclVatCents / factor
    previous = due
  }
  return Math.round(pv)
}

describe("presentValueOfRentals", () => {
  it("at 0% is the sum of the rentals still to fall due; a rental due on the termination date is not one of them", () => {
    const rows = rentals(12, "2027-01-15", 1_000_000)
    expect(presentValueOfRentals(rows, "2027-03-15", 0)).toBe(9 * 1_000_000)
    expect(presentValueOfRentals(rows, "2027-03-14", 0)).toBe(10 * 1_000_000)
  })

  it.each([0.0825, 0.1175, 0.2])("agrees with the day-walk oracle to the cent at %s", (rate) => {
    const rows = rentals(36, "2027-01-31", 4_321_987)
    for (const from of ["2027-01-31", "2027-06-10", "2028-02-29", "2029-11-30"]) {
      expect(presentValueOfRentals(rows, from, rate)).toBe(oraclePv(rows, from, rate))
    }
  })
})

describe("earlyTerminationAmount (goal 2a.4)", () => {
  const rows = rentals(24, "2027-01-15", 2_000_000)
  it("PV of the remaining rental-only portions + arrears + the penalty %; the PV and penalty are invoiced with VAT", () => {
    const a = earlyTerminationAmount({ rentals: rows, terminationDate: "2028-01-15", annualRate: 0, arrearsCents: 345_000, penaltyRate: "0.1", vatRateTenThousandths: 1500 })
    expect(a).toEqual({
      // Rental 13 is due on the termination date itself: 14–24 remain.
      remainingRentals: 11, pvCents: 22_000_000, penaltyCents: 2_200_000, arrearsCents: 345_000,
      invoiceExclVatCents: 24_200_000, invoiceVatCents: 3_630_000, totalCents: 24_200_000 + 3_630_000 + 345_000,
    })
  })
  it("rounds the penalty half-up on the PV", () => {
    const a = earlyTerminationAmount({ rentals: rentals(1, "2027-02-01", 333), terminationDate: "2027-01-01", annualRate: 0, arrearsCents: 0, penaltyRate: "0.015", vatRateTenThousandths: 1500 })
    expect(a.penaltyCents).toBe(5) // 4.995 → 5
  })
  it("nothing left to fall due: only the arrears", () => {
    const a = earlyTerminationAmount({ rentals: rows, terminationDate: "2030-01-01", annualRate: 0.1, arrearsCents: 10, penaltyRate: "0.1", vatRateTenThousandths: 1500 })
    expect(a).toMatchObject({ remainingRentals: 0, pvCents: 0, penaltyCents: 0, invoiceExclVatCents: 0, totalCents: 10 })
  })
})

describe("cpaCancellationDate", () => {
  it("is 20 South African business days after notice (weekends and public holidays skipped)", () => {
    // 2027-12-01 (Wed) + 20 business days, skipping 16 Dec and 27 Dec (26 Dec falls on a Sunday).
    expect(cpaCancellationDate("2027-12-01")).toBe("2027-12-31")
  })
})
