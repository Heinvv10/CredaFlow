/**
 * Applies a change of reference rate to one variable-rate loan, inside the caller's transaction (reprice.ts says what changes).
 * The loan row is locked first, which serialises every receipt, so the rows read cannot be paid under the repricing. A row is
 * appended to LoanTerms (never changed, sequence + 1), the untouched rows are regenerated in place, and the loan's totals move
 * by the change in interest: the agreed baseline too, so a repriced loan settles on the repriced schedule.
 *
 * IDEMPOTENT per (loan, effective date): a loan already on that date or a later one answers already_repriced, read under the
 * lock; the unique (loan, sequence) and guardLoanTerms are the backstop. A change that leaves the rate where it was, or finds
 * no row to regenerate, writes nothing, and is looked at again on the next run.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate, isoOfDbDate } from "@/lib/asset-finance/dates"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import type { Tx } from "@/lib/maker-checker/types"
import { planReprice } from "./reprice"
import type { Frequency, RepaymentStructure, VariableRateBasis } from "./types"
import { rateFromReference, type ReferenceValue } from "./variable-rate"

export type RepriceOutcome =
  | { kind: "repriced"; sequence: number; ratePm: number; interestDelta: number; rows: number }
  | { kind: "already_repriced" | "unchanged" | "no_rows" }
  | { kind: "not_eligible"; reason: "not_active" | "not_variable" | "other_basis" | "no_structure" }

const SYSTEM_ACTOR = "system:loan-rate-reprice"

export async function repriceLoan(tx: Tx, input: { tenantId: string; loanId: string; basis: VariableRateBasis; reference: ReferenceValue; today: string }): Promise<RepriceOutcome> {
  const { tenantId, loanId, basis, reference, today } = input
  await lockLoanForUpdate(tx, loanId)
  const loan = await tx.loan.findFirst({
    where: { id: loanId, tenantId },
    select: {
      status: true, startDate: true, contractualTotalInterest: true, contractualTotalRepayable: true,
      terms: { orderBy: { sequence: "desc" }, take: 1 },
      repaymentSchedule: { orderBy: { installmentNo: "asc" }, select: { id: true, installmentNo: true, dueDate: true, principalDue: true, interestDue: true, feesDue: true, creditLifePremiumDue: true, totalDue: true, totalPaid: true, status: true, commonLawContractualInterestDue: true, carriedPrincipalDue: true, carriedInterestDue: true } },
    },
  })
  const last = loan?.terms[0]
  if (!loan || loan.status !== "ACTIVE") return { kind: "not_eligible", reason: "not_active" }
  if (!last?.rateBasis || last.rateMarginPa === null || !last.referenceEffectiveDate) return { kind: "not_eligible", reason: "not_variable" }
  if (last.rateBasis !== basis) return { kind: "not_eligible", reason: "other_basis" }
  if (!last.frequency || !last.structure) return { kind: "not_eligible", reason: "no_structure" }
  if (isoOfDbDate(last.referenceEffectiveDate) >= reference.effectiveDate) return { kind: "already_repriced" }

  const newRatePm = rateFromReference(reference.rate, last.rateMarginPa)
  if (newRatePm === last.interestRatePm) return { kind: "unchanged" }
  const plan = planReprice({
    rows: loan.repaymentSchedule, startDate: loan.startDate, frequency: last.frequency as Frequency, structure: last.structure as RepaymentStructure, balloonCents: last.balloonCents,
    newRatePm, effectiveDate: reference.effectiveDate, today,
  })
  if (!plan) return { kind: "no_rows" }

  const sequence = last.sequence + 1
  const created = await tx.loanTerms.create({
    data: {
      tenantId, loanId, sequence, productVersionId: last.productVersionId, frequency: last.frequency, structure: last.structure, graceKind: last.graceKind, graceInstalments: last.graceInstalments,
      instalments: last.instalments, balloonCents: last.balloonCents, pricingRuleId: last.pricingRuleId, pricingRuleName: last.pricingRuleName, pricingInputs: last.pricingInputs ?? undefined,
      // The base follows the reference with the rate; a rule's discount is inside the margin the loan keeps.
      baseRatePm: last.pricingRuleId ? Math.min(0.99, Math.max(0, last.baseRatePm + newRatePm - last.interestRatePm)) : newRatePm, interestRatePm: newRatePm,
      rateBasis: basis, rateMarginPa: last.rateMarginPa, referenceRate: reference.rate, referenceEffectiveDate: dbDate(reference.effectiveDate),
    },
  })
  for (const update of plan.updates) {
    const { id, ...amounts } = update
    const written = await tx.repaymentSchedule.updateMany({ where: { id, tenantId, loanId, status: "PENDING", totalPaid: 0 }, data: amounts })
    if (written.count !== 1) throw new Error(`Repricing ${loanId}: schedule row ${id} changed under the loan lock`)
  }
  const delta = plan.interestDelta
  await tx.loan.update({
    where: { id: loanId, tenantId },
    data: {
      interestRatePm: newRatePm, totalInterest: { increment: delta }, totalRepayable: { increment: delta },
      ...(loan.contractualTotalInterest !== null ? { contractualTotalInterest: { increment: delta } } : {}),
      ...(loan.contractualTotalRepayable !== null ? { contractualTotalRepayable: { increment: delta } } : {}),
    },
  })
  await logAuditStrict({
    tenantId, userEmail: SYSTEM_ACTOR, action: AuditAction.LOAN_RATE_REPRICED, entity: "Loan", entityId: loanId,
    oldValue: { interestRatePm: last.interestRatePm, referenceRate: last.referenceRate, referenceEffectiveDate: isoOfDbDate(last.referenceEffectiveDate), sequence: last.sequence },
    newValue: { interestRatePm: newRatePm, basis, marginPa: last.rateMarginPa, referenceRate: reference.rate, referenceEffectiveDate: reference.effectiveDate, sequence, loanTermsId: created.id, rowsRegenerated: plan.updates.length, interestDelta: delta },
  }, tx)
  return { kind: "repriced", sequence, ratePm: newRatePm, interestDelta: delta, rows: plan.updates.length }
}
