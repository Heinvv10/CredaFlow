interface AffordabilityDisplaySnapshot {
  inputs: {
    monthlyIncomeCents: number
    monthlyExpensesCents: number
    proposedInstalmentCents: number
  }
}

export function resolveAffordabilityDisplayInputs(args: {
  locked: boolean
  snapshot: AffordabilityDisplaySnapshot | null
  liveMonthlyIncomeCents: number
  liveMonthlyExpensesCents: number
  liveProposedInstalmentCents: number
}) {
  if (!args.locked) {
    return {
      monthlyIncomeCents: args.liveMonthlyIncomeCents,
      monthlyExpensesCents: args.liveMonthlyExpensesCents,
      proposedInstalmentCents: args.liveProposedInstalmentCents,
    }
  }
  return {
    monthlyIncomeCents: args.snapshot?.inputs.monthlyIncomeCents ?? 0,
    monthlyExpensesCents: args.snapshot?.inputs.monthlyExpensesCents ?? 0,
    proposedInstalmentCents: args.snapshot?.inputs.proposedInstalmentCents ?? 0,
  }
}
