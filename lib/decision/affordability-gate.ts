import { assessAffordability } from "@/lib/affordability/ndi"

/** Pure affordability gate. Reuses assessAffordability; debt = max(declared,
 *  bureau-observed) so a borrower cannot under-declare. The configured buffer
 *  requires NDI (before this loan) >= instalment × (ndiBufferPct/100), and the
 *  engine's own instalment:discretionary ratio (<=0.7) must also hold. */
export function evaluateAffordabilityGate(args: {
  monthlyIncomeCents: number
  monthlyExpensesCents: number
  declaredDebtCents: number
  bureauObligationsCents: number
  proposedInstalmentCents: number
  ndiBufferPct: number
}): { blocked: boolean; reason?: string; ndi: number; requiredNdi: number } {
  const effectiveDebt = Math.max(args.declaredDebtCents, args.bureauObligationsCents)
  const a = assessAffordability({
    monthlyIncomeCents: args.monthlyIncomeCents,
    monthlyExpensesCents: args.monthlyExpensesCents,
    debts: [{ monthlyInstalment: effectiveDebt }],
    proposedInstalmentCents: args.proposedInstalmentCents,
  })
  // Integer-first so the result matches Postgres NUMERIC math exactly:
  // CEIL(i * (pct/100)) in the DB guard is exact decimal, while JS
  // i * (pct/100) drifts a float-epsilon high whenever the true product is a
  // whole number (e.g. 186900 * 1.1), making Math.ceil land one cent above
  // the DB's answer and the approval trigger reject the evidence.
  const requiredNdi = Math.ceil((args.proposedInstalmentCents * args.ndiBufferPct) / 100)
  const ndi = a.netDisposableIncome
  if (ndi < requiredNdi) {
    return { blocked: true, ndi, requiredNdi, reason: `Net disposable income ${ndi} below required ${requiredNdi} (instalment × ${args.ndiBufferPct}%).` }
  }
  if (a.ratio > 0.7) {
    return { blocked: true, ndi, requiredNdi, reason: "Instalment exceeds 70% of discretionary income." }
  }
  return { blocked: false, ndi, requiredNdi }
}
