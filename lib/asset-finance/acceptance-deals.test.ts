// Acceptance: the solver and the VAT split reproduce each deal's figures to
// the cent (DESIGN.md "Acceptance (every slice)"). The figures are in
// ./__fixtures__/acceptance-deals.ts with their independent working.
import { describe, expect, it } from "vitest"
import { splitInclusive } from "@/lib/vat/amounts"
import { solveStructure } from "./structure"
import { priceLease } from "./lease-pricing"
import { earlyTerminationAmount } from "./lease-termination"
import { CLIENT_DEALS, LEASE_DEALS, SYNTHETIC_DEALS, type AcceptanceDeal, type AcceptanceLeaseDeal, type AcceptanceRow } from "./__fixtures__/acceptance-deals"

function pick(row: AcceptanceRow) {
  return {
    index: row.index,
    dueDate: row.dueDate,
    openingBalanceCents: row.openingBalanceCents,
    interestCents: row.interestCents,
    principalCents: row.principalCents,
    balloonCents: row.balloonCents,
    totalCents: row.totalCents,
  }
}

function assertDeal(deal: AcceptanceDeal) {
  const result = solveStructure(deal.input)
  const { expected } = deal
  expect(result.financedAmountCents).toBe(expected.financedAmountCents)
  expect(result.baseInstalmentCents).toBe(expected.baseInstalmentCents)
  expect(result.totalInterestCents).toBe(expected.totalInterestCents)
  expect(result.totalPayableCents).toBe(expected.totalPayableCents)
  expect([result.rows[0].interestCents, result.rows[1].interestCents]).toEqual(expected.firstTwoInterestCents)
  expect(result.rows).toHaveLength(expected.finalRow.index + 1)
  expect(pick(result.rows[expected.finalRow.index])).toEqual(expected.finalRow)
  for (const row of expected.rows ?? []) expect(pick(result.rows[row.index])).toEqual(row)
  const vat = splitInclusive(deal.input.cashPriceCents, deal.vatRateTenThousandths)
  expect({ exclVatCents: vat.exclVatCents, vatCents: vat.vatCents }).toEqual(expected.vat)
}

describe("acceptance: synthetic deals, independently derived", () => {
  it.each(SYNTHETIC_DEALS.map((deal) => [deal.id, deal] as const))("%s reproduces to the cent", (_id, deal) => {
    assertDeal(deal)
  })
})

// Lease deals (slice 3): rental, maintenance, VAT per line, escalation weights and the early-termination
// amount, against figures derived independently (./__fixtures__/acceptance-lease-deals.ts).
const PERIODS_PER_YEAR = 12

/** round_half_up(cents × factor), exact: the factor is a 6-decimal figure. */
const halfUpTimes = (cents: number, factor: number) =>
  Number((BigInt(2) * BigInt(cents) * BigInt(Math.round(factor * 1_000_000)) + BigInt(1_000_000)) / BigInt(2_000_000))

function assertLeaseDeal(deal: AcceptanceLeaseDeal) {
  const priced = priceLease(deal.input)
  const { expected } = deal
  expect(priced.capitalCents).toBe(deal.input.cashPriceExclVatCents)
  expect(priced.baseRentalCents).toBe(expected.baseRentalCents)
  expect(priced.periods).toHaveLength(deal.input.periods)
  expected.weightsByYear.forEach((weight, year) => expect(priced.weights[year * PERIODS_PER_YEAR]).toBe(weight))
  for (const want of expected.rows) {
    const got = priced.periods[want.periodNo - 1]
    expect({
      periodNo: got.periodNo, dueDate: got.dueDate, openingBalanceCents: got.row.openingBalanceCents, interestCents: got.row.interestCents,
      rentalExclVatCents: got.rentalExclVatCents, maintenanceExclVatCents: got.maintenanceExclVatCents, vatCents: got.vatCents, totalCents: got.totalCents,
    }).toEqual(want)
    expect(want.rentalExclVatCents + want.maintenanceExclVatCents + want.vatCents).toBe(want.totalCents)
  }
  expect({
    rentalExclVatCents: priced.totalRentalExclVatCents, maintenanceExclVatCents: priced.totalMaintenanceExclVatCents,
    vatCents: priced.totalVatCents, totalCents: priced.totalCents,
  }).toEqual(expected.totals)
  // The residual is what remains after the last rental: its opening balance + finance charge − its rental.
  const last = expected.rows[expected.rows.length - 1]
  expect(last.openingBalanceCents + last.interestCents - last.rentalExclVatCents).toBe(deal.input.residualCents)
  // Maintenance escalates by its own factor each year.
  const maintenance = deal.input.maintenance
  expected.maintenanceFactorsByYear?.forEach((factor, year) => {
    expect(priced.periods[year * PERIODS_PER_YEAR].maintenanceExclVatCents).toBe(halfUpTimes(maintenance?.monthlyExclVatCents ?? 0, factor))
  })

  const quote = deal.termination
  if (!quote) return
  const rentals = priced.periods.map((p) => ({ dueDate: p.dueDate, rentalExclVatCents: p.rentalExclVatCents }))
  const amount = earlyTerminationAmount({ ...quote.input, rentals })
  expect(amount).toEqual({
    remainingRentals: quote.remainingRentals, pvCents: quote.pvCents, penaltyCents: quote.penaltyCents, arrearsCents: quote.input.arrearsCents,
    invoiceExclVatCents: quote.invoiceExclVatCents, invoiceVatCents: quote.invoiceVatCents, totalCents: quote.totalCents,
  })
  expect(quote.pvCents + quote.penaltyCents).toBe(quote.invoiceExclVatCents)
  expect(quote.invoiceExclVatCents + quote.invoiceVatCents + quote.input.arrearsCents).toBe(quote.totalCents)
}

describe("acceptance: lease deals, independently derived", () => {
  it.each(LEASE_DEALS.map((deal) => [deal.id, deal] as const))("%s reproduces to the cent", (_id, deal) => {
    assertLeaseDeal(deal)
  })

  it("LSE-3's arrears are rentals 14 and 15 in full, a R250.00 fee and 29 days of default interest on rental 14 at 12.5% + 5%", () => {
    const deal = LEASE_DEALS.find((d) => d.id === "LSE-3")
    const total = (n: number) => deal?.expected.rows.find((r) => r.periodNo === n)?.totalCents ?? 0
    // Rental 14 fell due 29 complete days before T; rental 15 falls due on T and accrues nothing yet.
    const interest = Number((BigInt(2) * BigInt(total(14)) * BigInt(29) * BigInt(175) + BigInt(1000 * 365)) / BigInt(2 * 1000 * 365))
    expect(interest).toBe(62_508)
    expect(deal?.termination?.input.arrearsCents).toBe(total(14) + total(15) + 25_000 + interest)
  })
})

describe("acceptance: the client's anonymised deal pack", () => {
  if (CLIENT_DEALS.length === 0) {
    it.skip("Acceptance pack not supplied yet: add the client's anonymised deals to __fixtures__/acceptance-deals.ts", () => {})
    return
  }
  it.each(CLIENT_DEALS.map((deal) => [deal.id, deal] as const))("%s reproduces to the cent", (_id, deal) => {
    assertDeal(deal)
  })
})
