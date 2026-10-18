import { expect, it } from "vitest"
import { solveStructure } from "./structure"
import { monthly } from "./structure-presets"
import { toScheduleRecord } from "./schedule-records"
import { ratePayoffPlan } from "./reprice-payoff"
it("a large historical cut closes capital and preserves the resulting cash credit", () => {
  const booked = solveStructure({ cashPriceCents: 1000000, depositCents: 0, tradeInCents: 0, financedFeesCents: 0, balloonCents: 0, weights: monthly(36), startDate: "2020-01-15", ratePath: [{ effectiveDate: "2020-01-15", annualRate: 0.30 }] })
  const rows = booked.rows.map((row, i) => ({ ...toScheduleRecord(row), id: `synthetic-${i}`, status: i < 33 ? "PAID" : "PENDING", totalPaid: i < 33 ? row.totalCents : 0, assetFinanceOpeningBalanceCents: row.openingBalanceCents }))
  const plan = ratePayoffPlan({ rows, paidThroughIndex: 32, startDate: "2020-01-15", financedAmountCents: 1000000, ratePath: [{ effectiveDate: "2020-01-15", annualRate: 0.30 }, { effectiveDate: "2020-01-16", annualRate: 0 } ] })
  expect(plan.rows.reduce((sum,row) => sum + row.principalDue,0)).toBe(1000000)
  expect(plan.refundCents).toBe(rows.reduce((sum,row) => sum + row.totalPaid,0) - 1000000)
  expect(plan.rows.slice(plan.payoffIndex + 1).every((row) => row.totalDue === 0)).toBe(true)
})
