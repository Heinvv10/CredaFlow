import type { LoanFacts } from "./facts"
import type { DerivedOutcome } from "./definition"
import { lateOutcome, paidOutcome, returnedDebitOrderOutcome } from "./instalments"
import { windowOutcomes } from "./windows"

/** Every credit outcome of one loan, attached to the approval that produced it. */
export function deriveLoanOutcomes(decisionRecordId: string, facts: LoanFacts, today: string): DerivedOutcome[] {
  const rows = [
    ...facts.instalments.flatMap((inst) => [paidOutcome(inst, today), lateOutcome(inst, today)]),
    ...facts.returns.map(returnedDebitOrderOutcome),
    ...windowOutcomes(facts, today),
  ]
  return rows.map((row) => ({ decisionRecordId, ...row }))
}
