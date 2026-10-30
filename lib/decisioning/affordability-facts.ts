import { evaluateAffordabilityGate } from "@/lib/decision/affordability-gate"
import { assessAffordability } from "@/lib/affordability/ndi"
import type { AffordabilityDecisionSnapshot } from "@/lib/affordability/snapshot"

/**
 * The affordability facts a rule may read, from the same arithmetic the staff
 * approval gate runs (lib/decision/affordability-gate.ts): debt is the higher of
 * declared and bureau-observed, and "passes" is that gate's own verdict. Nothing
 * here is rounded: a rule's threshold is compared with the exact figure.
 */
export interface AffordabilityFacts {
  monthlyDebtCents: number
  instalmentCents: number | null
  ndiCents: number
  ndiCoverPct: number | null
  dtiPct: number | null
  affordabilityGatePasses: boolean | null
  expensesBelowMinimum: boolean
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : null)

export function liveAffordability(args: {
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  declaredDebtCents: number
  bureauObligationsCents: number
  proposedInstalmentCents: number | null
  ndiBufferPct: number
  expensesBelowMinimum: boolean
}): AffordabilityFacts {
  const monthlyDebtCents = Math.max(args.declaredDebtCents, args.bureauObligationsCents)
  const ndiCents = assessAffordability({
    monthlyIncomeCents: args.monthlyIncomeCents,
    monthlyExpensesCents: args.monthlyExpensesCents,
    debts: [{ monthlyInstalment: monthlyDebtCents }],
    proposedInstalmentCents: 0,
  }).netDisposableIncome
  const instalment = args.proposedInstalmentCents
  const gate = instalment === null ? null : evaluateAffordabilityGate({
    monthlyIncomeCents: args.monthlyIncomeCents,
    monthlyExpensesCents: args.monthlyExpensesCents,
    declaredDebtCents: args.declaredDebtCents,
    bureauObligationsCents: args.bureauObligationsCents,
    proposedInstalmentCents: instalment,
    ndiBufferPct: args.ndiBufferPct,
  })
  return {
    monthlyDebtCents,
    instalmentCents: instalment,
    ndiCents,
    ndiCoverPct: instalment === null ? null : pct(ndiCents, instalment),
    dtiPct: instalment === null ? null : pct(monthlyDebtCents + instalment, args.monthlyIncomeCents),
    affordabilityGatePasses: gate === null ? null : !gate.blocked,
    expensesBelowMinimum: args.expensesBelowMinimum,
  }
}

/** The same facts from a decision snapshot (lib/affordability/snapshot.ts), as it was recorded. */
export function snapshotAffordability(snapshot: Pick<AffordabilityDecisionSnapshot, "inputs" | "outcome" | "expenses">): AffordabilityFacts {
  const { inputs, outcome } = snapshot
  const instalment = outcome.netDisposableIncomeCents - outcome.ndiAfterLoanCents
  const monthlyDebtCents = Math.max(inputs.declaredDebtCents, inputs.bureauObligationsCents)
  return {
    monthlyDebtCents,
    instalmentCents: instalment,
    ndiCents: outcome.netDisposableIncomeCents,
    ndiCoverPct: pct(outcome.netDisposableIncomeCents, instalment),
    dtiPct: pct(monthlyDebtCents + instalment, inputs.monthlyIncomeCents),
    affordabilityGatePasses: outcome.isAffordable,
    expensesBelowMinimum: snapshot.expenses.mle.belowMinimum,
  }
}
