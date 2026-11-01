/** The loan a top-up, refinance or consolidation books. Pure, integer cents. */
import { generateSchedule } from "@/lib/product-engine/schedule"
import type { EngineInterestModel, Frequency, RepaymentTerms } from "@/lib/product-engine/types"
import type { FreshRow } from "./plan"

export interface NewLoanInput {
  settledCents: number
  newMoneyCents: number
  interestRatePm: number
  interestModel: EngineInterestModel
  monthlyServiceFee: number
  frequency: Frequency
  instalments: number
  asOf: Date
}

export interface NewLoanPlan {
  principal: number
  rows: FreshRow[]
  terms: RepaymentTerms
  totalInterest: number
  totalRepayable: number
  maturityDate: Date
}

/** The loan a top-up, refinance or consolidation books: its principal is what settles the old loan(s) plus the new money, from today. */
export function planNewLoan(input: NewLoanInput): NewLoanPlan {
  const principal = input.settledCents + input.newMoneyCents
  const terms: RepaymentTerms = { frequency: input.frequency, structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: input.instalments }
  const generated = generateSchedule({ principalCents: principal, interestRatePm: input.interestRatePm, interestModel: input.interestModel, monthlyServiceFeeCents: input.monthlyServiceFee, startDate: input.asOf, terms })
  const rows = generated.schedule.map((row) => ({ installmentNo: row.installmentNo, dueDate: row.dueDate, principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue, carriedInterestDue: 0, carriedFeesDue: 0 }))
  return {
    principal, rows, terms, totalInterest: generated.totalInterest,
    totalRepayable: rows.reduce((sum, row) => sum + row.totalDue, 0), maturityDate: rows.at(-1)!.dueDate,
  }
}
