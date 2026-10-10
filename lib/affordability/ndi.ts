// Net Disposable Income (NDI) affordability assessment.
// ALL money is in CENTS (integers) — the same convention as the rest of the app
// (client.monthlyIncome/monthlyExpenses, the LoanApplication NDI columns, and the
// ExistingDebtObligation table are all cents). Mixing rands and cents here flips
// lending decisions and is NCA s.80-81 reckless-lending evidence, so
// this is the single source of truth and the server recomputes from it — it never
// trusts a client-posted NDI.

export interface DebtObligationInput {
  monthlyInstalment: number // cents
}

export interface AffordabilityInput {
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  debts: DebtObligationInput[]
  proposedInstalmentCents: number
  /** Max instalment-to-discretionary-income ratio (default 0.7). */
  maxRatio?: number
}

export interface AffordabilityResult {
  totalExistingDebt: number // cents
  discretionaryIncome: number // cents: income - expenses (before existing debt)
  netDisposableIncome: number // cents: discretionary - existing debt
  ndiAfterLoan: number // cents: NDI - proposed instalment
  ratio: number // proposed instalment / discretionary income
  isAffordable: boolean
}

export function assessAffordability(input: AffordabilityInput): AffordabilityResult {
  const maxRatio = input.maxRatio ?? 0.7
  const totalExistingDebt = input.debts.reduce(
    (sum, d) => sum + Math.max(0, Math.round(d.monthlyInstalment || 0)),
    0,
  )
  const discretionaryIncome = input.monthlyIncomeCents - input.monthlyExpensesCents
  const netDisposableIncome = discretionaryIncome - totalExistingDebt
  const ndiAfterLoan = netDisposableIncome - input.proposedInstalmentCents
  const ratio = input.proposedInstalmentCents / Math.max(1, discretionaryIncome)
  const isAffordable = ndiAfterLoan >= 0 && ratio <= maxRatio
  return { totalExistingDebt, discretionaryIncome, netDisposableIncome, ndiAfterLoan, ratio, isAffordable }
}

/** Risk grade from the assessment. Mirrors the previous AffordabilityCapture bands. */
export function affordabilityRiskGrade(result: AffordabilityResult): "A" | "B" | "C" | "D" {
  const { ndiAfterLoan, discretionaryIncome } = result
  if (ndiAfterLoan >= discretionaryIncome * 0.4) return "A"
  if (ndiAfterLoan >= discretionaryIncome * 0.2) return "B"
  if (ndiAfterLoan >= 0) return "C"
  return "D"
}
