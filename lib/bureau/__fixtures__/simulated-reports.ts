/**
 * The simulated bureau's reports. Every value is synthetic: subscriber names
 * say SIMULATED, amounts are round, and nothing here describes a real person
 * or a real lender. Scores sit on the Experian Sigma band (480–710) so the
 * approval gate's calibrated floor reads them the way it reads Experian.
 */
import type { BureauTradeline } from "../types"

export type SimulatedScenario = "CLEAN" | "THIN_FILE" | "ADVERSE_JUDGEMENT" | "HIGH_DEBT"

export const SIMULATED_SCENARIOS: readonly SimulatedScenario[] = ["CLEAN", "THIN_FILE", "ADVERSE_JUDGEMENT", "HIGH_DEBT"]

export interface SimulatedFixture {
  score: number | null
  riskGrade: string | null
  declineReasons: string[]
  hasJudgement: boolean
  hasNotice: boolean
  underDebtReview: boolean
  defaults: string[]
  enquiriesLast90Days: number
  tradelines: BureauTradeline[]
}

const line = (subscriber: string, accountType: string, rands: number, open: boolean): BureauTradeline => ({
  subscriber: `${subscriber} (SIMULATED)`,
  accountType,
  instalmentCents: rands * 100,
  status: open ? "OPEN" : "CLOSED",
  open,
})

export const SIMULATED_FIXTURES: Record<SimulatedScenario, SimulatedFixture> = {
  CLEAN: {
    score: 655,
    riskGrade: "LOW RISK (SIMULATED)",
    declineReasons: [],
    hasJudgement: false,
    hasNotice: false,
    underDebtReview: false,
    defaults: [],
    enquiriesLast90Days: 1,
    tradelines: [
      line("SYNTHETIC BANK ALPHA", "VEHICLE FINANCE", 3500, true),
      line("SYNTHETIC RETAIL ONE", "STORE CARD", 450, true),
      line("SYNTHETIC BANK BETA", "PERSONAL LOAN", 1200, false),
    ],
  },
  // Too little history to score: one recent account.
  THIN_FILE: {
    score: null,
    riskGrade: null,
    declineReasons: ["INSUFFICIENT CREDIT HISTORY (SIMULATED)"],
    hasJudgement: false,
    hasNotice: false,
    underDebtReview: false,
    defaults: [],
    enquiriesLast90Days: 0,
    tradelines: [line("SYNTHETIC TELCO", "CELLULAR CONTRACT", 300, true)],
  },
  ADVERSE_JUDGEMENT: {
    score: 512,
    riskGrade: "HIGH RISK (SIMULATED)",
    declineReasons: ["JUDGEMENT RECORDED (SIMULATED)", "ACCOUNT IN ARREARS (SIMULATED)"],
    hasJudgement: true,
    hasNotice: false,
    underDebtReview: false,
    defaults: ["HANDED OVER FOR COLLECTION (SIMULATED)"],
    enquiriesLast90Days: 6,
    tradelines: [
      line("SYNTHETIC RETAIL TWO", "STORE CARD", 800, true),
      line("SYNTHETIC MICROLENDER", "SHORT TERM LOAN", 1500, true),
    ],
  },
  // Scores acceptably but already carries heavy instalments.
  HIGH_DEBT: {
    score: 598,
    riskGrade: "AVERAGE RISK (SIMULATED)",
    declineReasons: ["HIGH UTILISATION (SIMULATED)"],
    hasJudgement: false,
    hasNotice: false,
    underDebtReview: false,
    defaults: [],
    enquiriesLast90Days: 4,
    tradelines: [
      line("SYNTHETIC BANK ALPHA", "HOME LOAN", 9500, true),
      line("SYNTHETIC BANK BETA", "VEHICLE FINANCE", 6200, true),
      line("SYNTHETIC BANK GAMMA", "CREDIT CARD", 1850, true),
      line("SYNTHETIC MICROLENDER", "PERSONAL LOAN", 900, true),
    ],
  },
}
