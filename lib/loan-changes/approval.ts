/**
 * A top-up, refinance or consolidation is a new credit decision, so a lender's approval matrix and credit committee govern it as
 * they govern an application: the new loan's application carries the chain. The change stays SUBMITTED while the levels are
 * recorded; the last one completes it through the maker-checker approval, in that transaction. A change in place is not new credit
 * and has its one second person. With no matrix in force, the application is opened by the apply. Rules: lib/approval/.claude.md.
 */
import type { ChangeRequest } from "@prisma/client"
import { ApprovalChainChangedError, gateApproval } from "@/lib/approval/chain"
import { loadEffectiveMatrix } from "@/lib/approval/matrix-store"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { ChangeRequestError, InvalidPayloadError } from "@/lib/maker-checker/errors"
import type { Actor, ApprovalGateOutcome, Tx } from "@/lib/maker-checker/types"
import { prisma } from "@/lib/prisma"
import { PERIOD_DAYS } from "@/lib/product-engine/types"
import { generateReference } from "@/lib/utils"
import { computeChange, type NewLoanComputed } from "./compute"
import { LoanChangeRefused } from "./plan"
import { isNewLoanType, type LoanChangePayload } from "./types"

const APPLICATION_SELECT = { id: true, status: true, appliedAmount: true, productId: true, branchId: true, riskGradeRank: true, inputStaffIds: true } as const

const applicationOf = (db: Pick<Tx, "loanApplication">, tenantId: string, requestId: string) =>
  db.loanApplication.findFirst({ where: { tenantId, loanChangeRequestId: requestId }, select: APPLICATION_SELECT })

/** The new loan's application, under review, opened once per request. Its grade is the loan's it replaces. */
export async function loanChangeApplication(tx: Tx, tenantId: string, request: Pick<ChangeRequest, "id" | "makerId">, computed: NewLoanComputed, actor: Actor) {
  const existing = await applicationOf(tx, tenantId, request.id)
  if (existing) {
    if (existing.status !== "UNDER_REVIEW") throw new LoanChangeRefused(`The new loan's application is ${existing.status.toLowerCase().replace("_", " ")}: this change cannot be approved`)
    return existing
  }
  const { primary, plan } = computed
  const { riskGrade, riskGradedAt, riskGradeVersionId, riskGradeRank } = primary.application
  const opened = await tx.loanApplication.create({
    data: {
      tenantId, reference: generateReference("APP"), clientId: primary.clientId, productId: primary.productId, branchId: primary.application.branchId,
      appliedAmount: plan.principal, appliedTermDays: plan.terms.instalments * PERIOD_DAYS[plan.terms.frequency], purpose: primary.application.purpose, status: "UNDER_REVIEW",
      inputStaffIds: [request.makerId], loanChangeRequestId: request.id, riskGrade, riskGradedAt, riskGradeVersionId, riskGradeRank,
    },
    select: APPLICATION_SELECT,
  })
  await logAuditStrict({
    tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.LOAN_CHANGE_APPLICATION_OPENED, entity: "LoanApplication", entityId: opened.id,
    newValue: { changeRequestId: request.id, makerId: request.makerId, appliedAmount: plan.principal },
  }, tx)
  return opened
}

/** Two approvers at the same moment open one application: the unique request refuses the second, which reads the first. */
async function openOrLoad(tenantId: string, request: ChangeRequest, computed: NewLoanComputed, actor: Actor) {
  try {
    return await prisma.$transaction((tx) => loanChangeApplication(tx, tenantId, request, computed, actor))
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
    return (await applicationOf(prisma, tenantId, request.id))!
  }
}

export async function loanChangeApprovalGate(ctx: { tenantId: string; request: ChangeRequest; payload: LoanChangePayload; actor: Actor; note?: string }): Promise<ApprovalGateOutcome> {
  const { tenantId, request, payload, actor } = ctx
  if (!isNewLoanType(payload.type)) return { proceed: true }
  const now = new Date()
  if (!(await loadEffectiveMatrix(prisma, tenantId, now)) && !(await applicationOf(prisma, tenantId, request.id))) return { proceed: true }
  let computed
  try {
    computed = await computeChange(prisma, tenantId, payload, now)
    if (computed.scope !== "NEW_LOAN") return { proceed: true }
    const application = await openOrLoad(tenantId, request, computed, actor)
    // The requirement follows today's figure: a settlement grows with time. It is raised if that asks for more, never lowered.
    await prisma.loanApplication.updateMany({ where: { id: application.id, tenantId, status: "UNDER_REVIEW" }, data: { appliedAmount: computed.plan.principal } })
    const gate = await gateApproval({ tenantId, application: { ...application, appliedAmount: computed.plan.principal }, user: actor, automated: false, note: ctx.note })
    if (gate.kind === "none") return { proceed: true }
    if (gate.kind === "final") return { proceed: true, inTransaction: gate.recordFinalStep }
    const body = gate.body as { error?: string; approvalRecorded?: boolean; level?: number; requiredLevels?: number }
    return body.approvalRecorded
      ? { proceed: false, levelRecorded: true, message: `Level ${body.level} of ${body.requiredLevels} recorded: the next level approves it` }
      : { proceed: false, levelRecorded: false, message: body.error ?? "The approval matrix refused this approval" }
  } catch (error) {
    if (error instanceof LoanChangeRefused) throw new InvalidPayloadError([error.message])
    if (error instanceof ApprovalChainChangedError) throw new ChangeRequestError("STALE", error.message)
    throw error
  }
}

/** A rejected or withdrawn change leaves no application open: cancelling it closes its chain (the database does). */
export async function closeLoanChangeApplication(tx: Tx, ctx: { tenantId: string; request: ChangeRequest; actor: Actor }): Promise<void> {
  const { tenantId, request, actor } = ctx
  const closed = await tx.loanApplication.updateMany({ where: { tenantId, loanChangeRequestId: request.id, status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] } }, data: { status: "CANCELLED" } })
  if (closed.count === 0) return
  await logAuditStrict({
    tenantId, userId: actor.id, userEmail: actor.email, action: AuditAction.LOAN_CHANGE_APPLICATION_CLOSED, entity: "ChangeRequest", entityId: request.id,
    newValue: { status: request.status },
  }, tx)
}
