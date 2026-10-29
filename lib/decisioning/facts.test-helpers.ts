import type { DecisionFacts } from "./facts"

/** A synthetic applicant who passes ordinary rules; override what a test is about. */
export function facts(over: Partial<DecisionFacts> = {}): DecisionFacts {
  return {
    productId: "prod_1",
    productCode: "MICRO30",
    productType: "MICRO",
    channel: "PORTAL",
    requestedAmountCents: 300_000,
    termDays: 90,
    ageYears: 34,
    employmentStatus: "EMPLOYED",
    incomeSourceType: "SALARY",
    employmentMonths: 48,
    monthlyIncomeCents: 2_000_000,
    monthlyExpensesCents: 800_000,
    monthlyDebtCents: 200_000,
    instalmentCents: 120_000,
    ndiCents: 1_000_000,
    ndiCoverPct: 833,
    dtiPct: 16,
    bureauAvailable: true,
    bureauScore: 640,
    bureauUnscoreable: false,
    bureauAdverse: false,
    bureauJudgement: false,
    bureauNotice: false,
    bureauUnderDebtReview: false,
    bureauDeceased: false,
    isRepeatClient: false,
    openLoansCount: 0,
    ...over,
  }
}
