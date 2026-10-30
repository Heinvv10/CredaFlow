import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { prisma } from "@/lib/prisma"
import type { Tx } from "@/lib/maker-checker/types"
import { authorityLevel, requiredLevelsFor } from "./evaluate"
import { delegatorLevels, loadDelegationsFor, loadEffectiveMatrix, loadMatrixVersion, type StoredMatrix } from "./matrix-store"
import { approversForLevel, notifyStaff } from "./notify"
import { planApproval } from "./plan"
import type { MatrixLevel } from "./types"

/** The chain moved between the decision reading it and committing (another approver got there first). */
export class ApprovalChainChangedError extends Error {
  constructor() {
    super("The approval chain changed while this approval was being recorded")
    this.name = "ApprovalChainChangedError"
  }
}

export interface GateApplication {
  id: string
  appliedAmount: number
  productId: string
  branchId: string | null
  riskGradeRank: number | null
  inputStaffIds: string[]
}

export interface GateInput {
  tenantId: string
  application: GateApplication
  user: { id: string; email: string; role: string }
  automated: boolean
  note?: string | null
  now?: Date
}

export type Gate =
  /** No matrix applies: the approval runs as it always did. */
  | { kind: "none" }
  /** Answer the caller with this (a refusal, or "level N recorded; awaiting the next"). */
  | { kind: "respond"; status: number; body: Record<string, unknown> }
  /** This approval completes the chain: run the approval, calling `recordFinalStep` inside its transaction before the status write. */
  | { kind: "final"; recordFinalStep: (tx: Tx) => Promise<void> }

const hours = (n: number) => n * 3_600_000

async function openCaseFor(tx: Tx, input: { tenantId: string; applicationId: string; matrix: StoredMatrix | null; now: Date }) {
  const existing = await tx.approvalCase.findFirst({ where: { tenantId: input.tenantId, applicationId: input.applicationId, status: "OPEN" } })
  if (existing || !input.matrix) return existing
  const first = input.matrix.payload.levels[0]
  try {
    return await tx.approvalCase.create({
      data: { tenantId: input.tenantId, applicationId: input.applicationId, matrixVersionId: input.matrix.id, levelStartedAt: input.now, dueAt: new Date(input.now.getTime() + hours(first.slaHours)) },
    })
  } catch (error) {
    if ((error as { code?: string }).code !== "P2002") throw error
    return tx.approvalCase.findFirst({ where: { tenantId: input.tenantId, applicationId: input.applicationId, status: "OPEN" } })
  }
}

/**
 * Starts the clock on an application's approval when its review starts, for a lender with a matrix in force. Idempotent; never throws
 * into the review (the case is also opened by the first approval attempt).
 */
export async function openApprovalCaseSafely(input: { tenantId: string; applicationId: string; now?: Date }): Promise<void> {
  try {
    const now = input.now ?? new Date()
    const matrix = await loadEffectiveMatrix(prisma, input.tenantId, now)
    if (!matrix) return
    await prisma.$transaction((tx) => openCaseFor(tx, { tenantId: input.tenantId, applicationId: input.applicationId, matrix, now }))
  } catch (error) {
    console.error("[approval] could not open the approval case; the first approval attempt will:", input.applicationId, error)
  }
}

/**
 * The approval matrix's say over one approval attempt. A lender with no matrix in force (and no case in flight) gets `none` and the
 * approval is exactly what it was. Otherwise the attempt is planned (./plan.ts): refused, recorded as one level of several, or the one
 * that completes the chain.
 */
export async function gateApproval(input: GateInput): Promise<Gate> {
  const now = input.now ?? new Date()
  const { tenantId, application, user } = input
  const effective = await loadEffectiveMatrix(prisma, tenantId, now)
  const hasCase = (await prisma.approvalCase.count({ where: { tenantId, applicationId: application.id, status: "OPEN" } })) > 0
  if (!effective && !hasCase) return { kind: "none" }

  const outcome = await prisma.$transaction(async (tx) => {
    let theCase = await openCaseFor(tx, { tenantId, applicationId: application.id, matrix: effective, now })
    if (!theCase) return { kind: "none" as const }
    // One attempt at a time per application's case.
    await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "ApprovalCase" WHERE "id" = ${theCase.id} FOR UPDATE`)
    theCase = await tx.approvalCase.findUniqueOrThrow({ where: { id: theCase.id } })
    const matrix = theCase.matrixVersionId ? await loadMatrixVersion(tx, tenantId, theCase.matrixVersionId) : effective
    if (!matrix) return { kind: "none" as const }
    if (theCase.requiredLevels === null) {
      const { requiredLevels, matchedRuleIds } = requiredLevelsFor(matrix.payload, {
        amountCents: application.appliedAmount, productId: application.productId, branchId: application.branchId, riskGradeRank: application.riskGradeRank,
      })
      theCase = await tx.approvalCase.update({
        where: { id: theCase.id },
        data: { requiredLevels, levelsSnapshot: matrix.payload.levels as never, matchedRuleIds, matrixVersionId: matrix.id },
      })
    }
    const levels = (theCase.levelsSnapshot as unknown as MatrixLevel[]) ?? matrix.payload.levels
    const required = theCase.requiredLevels ?? 0
    const steps = await tx.approvalStep.findMany({ where: { caseId: theCase.id }, select: { level: true, approverId: true }, orderBy: { level: "asc" } })
    const committeeLevel = levels.find((l) => l.committee)
    const committeeRows = committeeLevel
      ? await tx.creditCommitteeDecision.findMany({ where: { caseId: theCase.id, level: committeeLevel.level }, orderBy: { createdAt: "desc" }, select: { decision: true, conditions: true, recordedById: true } })
      : []
    const committeeDecision = committeeRows[0] ?? null
    const delegations = await loadDelegationsFor(tx, tenantId, user.id, now)
    const authority = authorityLevel({
      role: user.role as never, levels, delegations, amountCents: application.appliedAmount, now,
      delegatorLevels: await delegatorLevels(tx, tenantId, delegations, levels),
    })
    const plan = planApproval({ required, levels, steps, userId: user.id, inputStaffIds: application.inputStaffIds, authority, automated: input.automated, committeeDecision, committeeRecorderIds: committeeRows.map((d) => d.recordedById) })

    const stepData = (level: number, via: "ROLE" | "DELEGATION", delegationId: string | null) => ({
      tenantId, caseId: theCase!.id, applicationId: application.id, level, approverId: user.id, via, delegationId,
      note: input.note?.trim() || null,
      conditions: committeeLevel?.level === level && committeeDecision ? (committeeDecision.conditions as Prisma.InputJsonValue) : Prisma.DbNull,
    })
    const audit = (tx2: Tx, action: string, extra: Record<string, unknown>) => logAuditStrict({
      tenantId, userId: user.id, userEmail: user.email, action, entity: "LoanApplication", entityId: application.id,
      newValue: { caseId: theCase!.id, requiredLevels: required, matchedRuleIds: theCase!.matchedRuleIds, ...extra },
    }, tx2)

    if (plan.kind === "refuse") {
      if (!input.automated) await audit(tx as Tx, AuditAction.APPROVAL_STEP_REFUSED, { code: plan.code, pendingLevel: steps.length + 1 })
      return { kind: "respond" as const, status: plan.status, body: { error: plan.error, approvalMatrix: plan.code, requiredLevels: required, approvedLevels: steps.length } }
    }
    if (plan.kind === "final") {
      const closure = async (tx2: Tx) => {
        if (plan.level === 0) return
        try {
          await tx2.approvalStep.create({ data: stepData(plan.level, plan.via, plan.delegationId) })
        } catch (error) {
          if ((error as { code?: string }).code === "P2002" || String(error).includes("Approvals are recorded in order") || String(error).includes("approval case")) throw new ApprovalChainChangedError()
          throw error
        }
        await audit(tx2, AuditAction.APPROVAL_STEP_RECORDED, { level: plan.level, via: plan.via, delegationId: plan.delegationId, final: true })
      }
      return { kind: "final" as const, closure }
    }
    // One level of several: recorded now; the application stays under review for the next.
    await tx.approvalStep.create({ data: stepData(plan.level, plan.via, plan.delegationId) })
    const nextLevel = levels.find((l) => l.level === plan.level + 1)
    await tx.approvalCase.update({
      where: { id: theCase.id },
      data: { pendingLevel: plan.level + 1, levelStartedAt: now, dueAt: new Date(now.getTime() + hours((nextLevel ?? levels[levels.length - 1]).slaHours)), escalationCount: 0, lastEscalatedAt: null },
    })
    await audit(tx as Tx, AuditAction.APPROVAL_STEP_RECORDED, { level: plan.level, via: plan.via, delegationId: plan.delegationId, final: false })
    const recipients = await approversForLevel(tx, { tenantId, levels, level: plan.level + 1, amountCents: application.appliedAmount, exclude: [...application.inputStaffIds, ...steps.map((s) => s.approverId), user.id], now })
    await notifyStaff(tx, { tenantId, userIds: recipients, type: "APPROVAL_PENDING", title: "An application awaits your approval", body: `Level ${plan.level} of ${required} has approved; level ${plan.level + 1} (${nextLevel?.name ?? ""}) is next.`, applicationId: application.id })
    return { kind: "respond" as const, status: 200, body: { ok: true, status: "UNDER_REVIEW", approvalRecorded: true, level: plan.level, requiredLevels: required, nextLevel: plan.level + 1, nextLevelName: nextLevel?.name ?? null } }
  })

  if (outcome.kind === "none") return { kind: "none" }
  if (outcome.kind === "final") return { kind: "final", recordFinalStep: outcome.closure }
  return { kind: "respond", status: outcome.status, body: outcome.body }
}
