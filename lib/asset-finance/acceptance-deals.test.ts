// Acceptance: the solver and the VAT split reproduce each deal's figures to
// the cent (DESIGN.md "Acceptance (every slice)"). The figures are in
// ./__fixtures__/acceptance-deals.ts with their independent working.
import { describe, expect, it } from "vitest"
import { splitInclusive } from "@/lib/vat/amounts"
import { solveStructure } from "./structure"
import { CLIENT_DEALS, SYNTHETIC_DEALS, type AcceptanceDeal, type AcceptanceRow } from "./__fixtures__/acceptance-deals"

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

describe("acceptance: the client's anonymised deal pack", () => {
  if (CLIENT_DEALS.length === 0) {
    it.skip("Acceptance pack not supplied yet: add the client's anonymised deals to __fixtures__/acceptance-deals.ts", () => {})
    return
  }
  it.each(CLIENT_DEALS.map((deal) => [deal.id, deal] as const))("%s reproduces to the cent", (_id, deal) => {
    assertDeal(deal)
  })
})
