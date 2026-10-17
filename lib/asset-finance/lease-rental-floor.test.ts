import { describe, expect, it } from "vitest"
import { leaseRentalFloorPlan } from "./lease-rental-floor"
const base = {
  openingCents: 100_000,
  residualCents: 30_000,
  startDate: "2026-01-01",
  effectiveDate: "2026-01-01",
  paidThroughIndex: 1,
  keptThroughIndex: 1,
  ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0 }],
  rentals: [
    { dueDate: "2026-02-01", rentalExclVatCents: 60_000 },
    { dueDate: "2026-03-01", rentalExclVatCents: 60_000 },
    { dueDate: "2026-04-01", rentalExclVatCents: 60_000 },
  ],
}
describe("lease rental floor preserves the lessor residual without debtor top-up", () => {
  it("turns a negative historical funding balance into an own-supply credit and zero future rental", () => {
    const plan = leaseRentalFloorPlan(base)!
    expect(plan.credits).toEqual([{ index: 1, exclVatCents: 50_000 }])
    expect(plan.rentals).toEqual([60_000, 10_000, 0])
    expect(plan.endingCapitalCents).toBe(30_000)
    expect(plan.lessorRoundingCents).toBe(0)
  })
  it("keeps notice-window rentals, preserves the residual and spreads a credit over its own historical supplies", () => {
    const plan = leaseRentalFloorPlan({
      ...base,
      keptThroughIndex: 2,
      rentals: [...base.rentals, { dueDate: "2026-05-01", rentalExclVatCents: 60_000 }],
    })!
    expect(plan.rentals).toEqual([10_000, 0, 60_000, 0])
    expect(plan.credits).toEqual([
      { index: 1, exclVatCents: 60_000 },
      { index: 0, exclVatCents: 50_000 },
    ])
  })
  it("does not replace a positive remaining funding rental", () => {
    expect(leaseRentalFloorPlan({ ...base, openingCents: 200_000 })).toBeNull()
  })
  it("gives integer rounding to the lessor rather than inventing a final bill", () => {
    const input = {
      ...base,
      openingCents: 99_997,
      residualCents: 30_003,
      ratePath: [{ effectiveDate: "2026-01-01", annualRate: 0.2375 }],
    }
    const plan = leaseRentalFloorPlan(input)!
    let capital = input.openingCents,
      previous = Date.parse(input.startDate)
    for (const [index, rental] of input.rentals.entries()) {
      const day = Date.parse(rental.dueDate),
        days = (day - previous) / 86_400_000
      capital += Math.round((Math.max(0, capital) * 0.2375 * days) / 365) - plan.rentals[index]
      previous = day
    }
    expect(capital).toBe(plan.endingCapitalCents)
    expect(capital).toBeLessThanOrEqual(input.residualCents)
    expect(plan.lessorRoundingCents).toBe(input.residualCents - capital)
    expect(plan.rentals[2]).toBe(0)
    expect(
      plan.credits.every(
        (credit) => credit.exclVatCents > 0 && credit.exclVatCents <= input.rentals[credit.index].rentalExclVatCents
      )
    ).toBe(true)
  })
})

it("does not invent a refund for payments before the new rate became effective", () => {
  const plan = leaseRentalFloorPlan({ ...base, openingCents: 149_000, effectiveDate: "2026-03-02" })!
  expect(plan.credits).toEqual([])
  expect(plan.rentals).toEqual([60_000, 60_000, 0])
  expect(plan.lessorFundingDifferenceCents).toBe(1000)
  expect(plan.lessorRoundingCents).toBe(0)
})
