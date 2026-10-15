import { describe, expect, it } from "vitest"
import { cashAggregates } from "./cash-aggregation"
import { CASH_THRESHOLD_CENTS } from "./cash-threshold"

const half = Math.ceil(CASH_THRESHOLD_CENTS / 2)
const receipt = (paymentId: string, over: Partial<Parameters<typeof cashAggregates>[0][number]> = {}) => ({
  paymentId, clientId: "c1", amount: half, receivedAt: new Date("2026-10-14T08:00:00Z"), reversed: false, paymentMethod: "CASH", ...over,
})

describe("cash aggregation flag (split deposits)", () => {
  it("flags one client's same-SAST-day cash receipts, each under the threshold, that together reach it", () => {
    expect(cashAggregates([receipt("p1"), receipt("p2")])).toEqual([
      { clientId: "c1", day: "2026-10-14", totalCents: half * 2, paymentIds: ["p1", "p2"] },
    ])
  })

  it("does not flag receipts on different SAST days, of different clients, under the threshold together, reversed, or non-cash", () => {
    expect(cashAggregates([receipt("p1"), receipt("p2", { receivedAt: new Date("2026-10-14T22:30:00Z") })])).toEqual([])
    expect(cashAggregates([receipt("p1"), receipt("p2", { clientId: "c2" })])).toEqual([])
    expect(cashAggregates([receipt("p1", { amount: 100 }), receipt("p2", { amount: 100 })])).toEqual([])
    expect(cashAggregates([receipt("p1"), receipt("p2", { reversed: true })])).toEqual([])
    expect(cashAggregates([receipt("p1"), receipt("p2", { paymentMethod: "EFT" })])).toEqual([])
  })

  it("leaves a single receipt at or above the threshold to the CTR register itself", () => {
    expect(cashAggregates([receipt("p1", { amount: CASH_THRESHOLD_CENTS }), receipt("p2")])).toEqual([])
  })
})
