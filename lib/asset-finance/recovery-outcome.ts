// Post-sale figures of a recovery. ALL money is CENTS.
//  net      = gross proceeds − costs deducted from the proceeds
//  owed     = settlement + costs charged to the account
//  payment  = what is applied to the loan: min(net, settlement)
//  shortfall / surplus = the gap either way between net and owed
// Charged costs stay on the recovery (the shortfall includes them); they are
// never part of the payment. Mirrors the Recovery guard: net = gross − deducted.
// The cost treatment and the order of application are signed off by the lender's legal team, 2026-10-17.

export interface RecoveryOutcomeInput {
  settlementDueCents: number
  grossProceedsCents: number
  deductedCostsCents: number
  chargedCostsCents: number
}

export interface RecoveryOutcome {
  netProceedsCents: number
  paymentCents: number
  shortfallCents: number
  surplusCents: number
}

export interface RecoveryCostLine {
  grossCents: number
  treatment: "DEDUCT_FROM_PROCEEDS" | "CHARGE_TO_ACCOUNT"
}

function requireCents(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be non-negative integer cents`)
  }
}

export function recoveryOutcome(input: RecoveryOutcomeInput): RecoveryOutcome {
  requireCents(input.settlementDueCents, "Settlement due")
  requireCents(input.grossProceedsCents, "Gross proceeds")
  requireCents(input.deductedCostsCents, "Deducted costs")
  requireCents(input.chargedCostsCents, "Charged costs")
  if (input.deductedCostsCents > input.grossProceedsCents) {
    throw new RangeError("Costs deducted from the proceeds cannot exceed the gross proceeds")
  }
  const netProceedsCents = input.grossProceedsCents - input.deductedCostsCents
  const owedCents = input.settlementDueCents + input.chargedCostsCents
  return {
    netProceedsCents,
    paymentCents: Math.min(netProceedsCents, input.settlementDueCents),
    shortfallCents: Math.max(0, owedCents - netProceedsCents),
    surplusCents: Math.max(0, netProceedsCents - owedCents),
  }
}

/**
 * What the account still owes: the shortfall less the charged costs the loan's
 * ledger could not carry (Recovery.unrecoverableCostsCents, null before the
 * proceeds). shortfallCents itself still includes them.
 */
export function accountShortfall(shortfallCents: number, unrecoverableCostsCents: number | null): number {
  return shortfallCents - (unrecoverableCostsCents ?? 0)
}

export function costTotals(costs: RecoveryCostLine[]): { deducted: number; charged: number } {
  let deducted = 0
  let charged = 0
  for (const cost of costs) {
    requireCents(cost.grossCents, "Cost")
    if (cost.treatment === "DEDUCT_FROM_PROCEEDS") deducted += cost.grossCents
    else charged += cost.grossCents
  }
  return { deducted, charged }
}
