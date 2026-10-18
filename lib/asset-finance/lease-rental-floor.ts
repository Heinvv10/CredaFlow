import { periodInterest } from "./amortise"
import { toDayNumber } from "./dates"
import { rateDaySum, rateSegments } from "./rates"
import type { RatePoint } from "./types"

interface FloorInput {
  openingCents: number
  residualCents: number
  startDate: string
  effectiveDate: string
  paidThroughIndex: number
  keptThroughIndex: number
  ratePath: RatePoint[]
  rentals: Array<{ dueDate: string; rentalExclVatCents: number }>
}

/** Historical credits adjust only their own supplied rental consideration.
 * Future rental cash floors at zero; the retained residual never becomes a bill.
 * Integer rounding below the residual remains the lessor's funding difference. */
export function leaseRentalFloorPlan(input: FloorInput) {
  const start = toDayNumber(input.startDate)
  const segments = rateSegments(input.ratePath, start)
  const days = input.rentals.map((rental) => toDayNumber(rental.dueDate))
  const payments = input.rentals.map((rental, index) =>
    index <= input.keptThroughIndex ? rental.rentalExclVatCents : 0
  )
  const replay = () => {
    let capital = input.openingCents
    const rows = payments.map((payment, index) => {
      const openingCents = capital
      const interestCents = periodInterest(
        Math.max(0, capital),
        rateDaySum(segments, index ? days[index - 1] : start, days[index])
      )
      capital += interestCents - payment
      return { openingCents, interestCents, paymentCents: payment, closingCents: capital }
    })
    return { rows, capital }
  }
  if (replay().capital > input.residualCents) return null
  // Cash beyond already extinguished funding cannot make a negative capital
  // balance accrue charges. Attribute that excess to the supply that received it.
  for (let index = 0; index <= input.paidThroughIndex; index++) {
    const row = replay().rows[index]
    if (row.closingCents < 0 && input.rentals[index].dueDate >= input.effectiveDate) payments[index] += row.closingCents
  }
  let boundaryFound = false
  for (let index = input.paidThroughIndex; index >= 0; index--) {
    if (input.rentals[index].dueDate < input.effectiveDate) continue
    const original = payments[index]
    payments[index] = 0
    if (replay().capital <= input.residualCents) {
      continue
    }
    let low = 0,
      high = original
    while (low < high) {
      const credit = Math.ceil((low + high) / 2)
      payments[index] = original - credit
      if (replay().capital <= input.residualCents) low = credit
      else high = credit - 1
    }
    payments[index] = original - low
    boundaryFound = true
    break
  }
  const credits = input.rentals
    .flatMap((rental, index) =>
      index <= input.paidThroughIndex && rental.rentalExclVatCents > payments[index]
        ? [{ index, exclVatCents: rental.rentalExclVatCents - payments[index] }]
        : []
    )
    .reverse()
  const final = replay()
  if (final.rows.some((row) => row.openingCents < 0) || final.capital < 0) {
    throw new Error("Zero-rental funding cannot be reconciled from the affected historical supplies")
  }
  return {
    rentals: payments,
    credits,
    rows: final.rows,
    endingCapitalCents: final.capital,
    lessorFundingDifferenceCents: input.residualCents - final.capital,
    lessorRoundingCents: boundaryFound ? input.residualCents - final.capital : 0,
  }
}
export type LeaseRentalFloorPlan = NonNullable<ReturnType<typeof leaseRentalFloorPlan>>
