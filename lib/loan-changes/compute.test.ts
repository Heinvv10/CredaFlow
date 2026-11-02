import { describe, expect, it } from "vitest"
import { factsOf, inArrears, type ChangeLoan } from "./compute"

const row = (over: Record<string, unknown> = {}) => ({ dueDate: new Date("2030-01-01"), principalDue: 100, interestDue: 0, feesDue: 0, totalDue: 100, totalPaid: 0, ...over })
const loan = (over: Record<string, unknown> = {}) => ({
  status: "ACTIVE", principal: 100, totalPaid: 0, assetId: null, assetFinanceDeal: null, client: {}, interestModel: "FLAT", creditLifePremiums: 0, contractType: "LOAN", debtReviewNoticeAt: null, collectionsStage: "NONE",
  application: { disclosureRegime: "KEY_FACTS", repaymentMethod: "EFT" }, product: { active: true }, paymentArrangement: null, paymentPlan: null, _count: { debitMandates: 0, collectionInstructions: 0 },
  chargesAccrued: 0, chargesOutstanding: 0, repaymentSchedule: [row()], ...over,
}) as unknown as ChangeLoan

describe("factsOf", () => {
  it("a schedule ties when its rows add up to the loan's principal and to what it has been paid", () => {
    expect(factsOf(loan()).scheduleTies).toBe(true)
    expect(factsOf(loan({ principal: 101 })).scheduleTies).toBe(false)
    expect(factsOf(loan({ totalPaid: 5 })).scheduleTies).toBe(false)
  })
})

describe("inArrears", () => {
  it("is a DEFAULTED status, or an instalment past due", () => {
    expect(inArrears(loan(), new Date("2026-01-01"))).toBe(false)
    expect(inArrears(loan({ status: "DEFAULTED" }), new Date("2026-01-01"))).toBe(true)
    expect(inArrears(loan({ repaymentSchedule: [row({ dueDate: new Date("2025-01-01") })] }), new Date("2026-01-01"))).toBe(true)
  })
})
