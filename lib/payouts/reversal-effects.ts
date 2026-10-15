/**
 * What approving a disbursement reversal does to the loan, inside the
 * decision's transaction (lib/payouts/reversal.ts):
 *
 *  - the loan becomes CANCELLED (the database allows CANCELLED only with an
 *    approved reversal) owing nothing: no balance, arrears or charges. Its
 *    totalInterest / totalRepayable and schedule amounts are NOT touched: the
 *    PASQ billing guard binds them to the signed agreement, and lib/loan/
 *    charges-summary.ts states zero for a CANCELLED loan instead;
 *  - every unpaid schedule row becomes CANCELLED (amounts unchanged), so
 *    overdue lists and collection-rate denominators leave them out and the
 *    documents state nothing due on them; WRITTEN_OFF stays a real write-off;
 *  - a bundled credit-life policy is cancelled the way
 *    app/api/insurance/policies/[id]/cancel does (commissions clawed back,
 *    POLICY_CANCELLED audited);
 *  - it reports whether the bureau already knows the account (a cancellation
 *    "V" record must then be submitted by hand; lib/bureau-submission holds it)
 *    and that there is no mandate register on this build to cancel a debit
 *    mandate in (the collections engine adds one).
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export const NO_MANDATE_REGISTER = "no mandate register on this build: cancel any live debit order with the bank or collection provider by hand"

export interface ReversalEffects {
  scheduleRowsSettled: number
  policiesCancelled: string[]
  bureauCancellationRequired: boolean
  debitMandate: string
}

export async function applyReversalEffects(tx: Tx, args: {
  tenantId: string
  loanId: string
  reversalId: string
  actor: { id: string; email: string }
  now: Date
}): Promise<ReversalEffects> {
  const { tenantId, loanId, now } = args
  const cancelled = await tx.loan.updateMany({
    where: { id: loanId, tenantId, status: { in: ["ACTIVE", "DEFAULTED"] } },
    data: {
      status: "CANCELLED", closedAt: now, outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0,
      nextPaymentDate: null, collectionsStage: "NONE", chargesOutstanding: 0,
    },
  })
  if (cancelled.count !== 1) throw new Error("The loan changed while its disbursement was being reversed")
  const rows = await tx.repaymentSchedule.updateMany({
    where: { loanId, tenantId, status: { in: ["PENDING", "PARTIAL", "OVERDUE"] } },
    data: { status: "CANCELLED" },
  })
  const policies = await tx.insurancePolicy.findMany({
    where: { tenantId, linkedLoanId: loanId, status: { not: "CANCELLED" } },
    select: { id: true, status: true },
  })
  for (const policy of policies) {
    await tx.insurancePolicy.update({ where: { id: policy.id, tenantId }, data: { status: "CANCELLED" } })
    await tx.advisorCommission.updateMany({
      where: { policyId: policy.id, tenantId, status: { in: ["PENDING", "APPROVED"] } },
      data: { status: "CLAWED_BACK", clawedBackAt: now, clawbackReason: "Policy cancelled: loan disbursement reversed" },
    })
    await logAuditStrict({
      tenantId, userId: args.actor.id, userEmail: args.actor.email, action: "POLICY_CANCELLED",
      entity: "InsurancePolicy", entityId: policy.id,
      oldValue: { status: policy.status },
      newValue: { status: "CANCELLED", reason: "Loan disbursement reversed: the money never reached the borrower", reversalId: args.reversalId },
    }, tx)
  }
  const bureauLines = await tx.bureauSubmissionRecord.count({ where: { tenantId, loanId, mode: "LIVE", heldReason: null } })
  const effects: ReversalEffects = {
    scheduleRowsSettled: rows.count,
    policiesCancelled: policies.map((p) => p.id),
    bureauCancellationRequired: bureauLines > 0,
    debitMandate: NO_MANDATE_REGISTER,
  }
  await logAuditStrict({
    tenantId, userId: args.actor.id, userEmail: args.actor.email, action: AuditAction.LOAN_CANCELLED,
    entity: "Loan", entityId: loanId, newValue: { status: "CANCELLED", reason: "disbursement_reversed", reversalId: args.reversalId, ...effects },
  }, tx)
  // Deferred guards (PASQ billing, credit-life commit invariants) must judge
  // now: Prisma does not report an error raised at COMMIT, and a refused
  // reversal must not read as approved.
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
  return effects
}
