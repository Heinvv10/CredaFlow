import type { AutoDecisionExecution, AutoDecisionRole, DecisionEngineMode, DeclineCategory, LoanRepaymentMethod } from "@prisma/client"
import { decideApplication } from "@/app/api/applications/[id]/decide/decide-application"
import { DECLINE_CLIENT_REASONS } from "@/lib/applications/decline-category"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { hasMinRole } from "@/lib/auth-guards"
import { recordDecisions } from "@/lib/learning-loop/decision-log"
import { triggerNotification } from "@/lib/notifications"
import { prisma } from "@/lib/prisma"
import type { LoadedFacts } from "./load-facts"
import { autoDecisionRecord, versionLabel } from "./records"
import type { Verdict } from "./types"

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

export interface RunContext {
  tenantId: string
  applicationId: string
  trigger: string
  mode: Exclude<DecisionEngineMode, "OFF">
  role: AutoDecisionRole
  version: { id: string; scopeKey: string; version: number }
  loaded: LoadedFacts
  verdict: Verdict
  startedAt: number
  now: Date
}

export interface Executed {
  execution: AutoDecisionExecution
  runId: string
  note: string | null
}

const elapsed = (ctx: RunContext) => Math.max(0, Math.round(performance.now() - ctx.startedAt))

function writeRun(tx: Pick<Tx, "autoDecisionRun">, ctx: RunContext, execution: AutoDecisionExecution, reasonCodes: readonly string[], note: string | null) {
  return tx.autoDecisionRun.create({
    data: {
      tenantId: ctx.tenantId,
      applicationId: ctx.applicationId,
      ruleSetVersionId: ctx.version.id,
      role: ctx.role,
      mode: ctx.mode,
      trigger: ctx.trigger,
      verdict: ctx.verdict.decision,
      reasonCodes: [...reasonCodes],
      riskGrade: ctx.verdict.riskGrade,
      score: ctx.verdict.score,
      execution,
      executionNote: note,
      latencyMs: elapsed(ctx),
    },
    select: { id: true },
  })
}

const recordFor = (ctx: RunContext, decision: "DECLINE" | "REFER", reasonCodes: readonly string[]) => autoDecisionRecord({
  tenantId: ctx.tenantId,
  applicationId: ctx.applicationId,
  clientId: ctx.loaded.application.clientId,
  decision,
  reasonCodes,
  declineCategory: decision === "DECLINE" ? ctx.verdict.declineCategory : null,
  riskGrade: ctx.verdict.riskGrade,
  role: ctx.role,
  version: ctx.version,
  bureauCheckId: ctx.loaded.bureauCheckId,
  facts: ctx.loaded.facts,
  decidedAt: ctx.now,
})

/** SHADOW: the verdict is recorded and acted on by no one. */
export async function recordShadow(ctx: RunContext): Promise<Executed> {
  const run = await writeRun(prisma, ctx, "NOT_ACTED", ctx.verdict.reasonCodes, null)
  return { execution: "NOT_ACTED", runId: run.id, note: null }
}

/** The application stays UNDER_REVIEW for staff, with the codes that sent it there. */
export async function refer(ctx: RunContext, reasonCodes: readonly string[], note: string | null): Promise<Executed> {
  return prisma.$transaction(async (tx) => {
    await recordDecisions(tx, [recordFor(ctx, "REFER", reasonCodes)])
    await logAuditStrict({
      tenantId: ctx.tenantId, action: AuditAction.AUTO_DECISION_REFERRED, entity: "LoanApplication", entityId: ctx.applicationId,
      newValue: { reasonCodes: [...reasonCodes], ruleSet: versionLabel(ctx.version), role: ctx.role, riskGrade: ctx.verdict.riskGrade },
    }, tx)
    const run = await writeRun(tx, ctx, "REFERRED", reasonCodes, note)
    return { execution: "REFERRED" as const, runId: run.id, note }
  })
}

/**
 * Declines UNDER_REVIEW -> DECLINED as a system decision: the client's reason is
 * the approved wording of the decline category, the codes go to the staff note
 * and the decision log (flagged for the lender's POPIA s71 review). Returns
 * null when the application left review first (staff got there).
 */
export async function declineAutomatically(ctx: RunContext): Promise<Executed | null> {
  const category: DeclineCategory = ctx.verdict.declineCategory ?? "POLICY"
  const clientReason = DECLINE_CLIENT_REASONS[category]
  const result = await prisma.$transaction(async (tx) => {
    const changed = await tx.loanApplication.updateMany({
      where: { id: ctx.applicationId, tenantId: ctx.tenantId, status: "UNDER_REVIEW" },
      data: {
        status: "DECLINED",
        approvedAt: ctx.now,
        decisionReason: clientReason,
        declineCategory: category,
        declineInternalNote: `Automatic decision (${versionLabel(ctx.version)}): ${ctx.verdict.reasonCodes.join(", ")}`,
      },
    })
    if (changed.count === 0) return null
    await logAuditStrict({
      tenantId: ctx.tenantId, action: AuditAction.LOAN_DECLINED, entity: "LoanApplication", entityId: ctx.applicationId,
      oldValue: { status: "UNDER_REVIEW" },
      newValue: { status: "DECLINED", reason: clientReason, declineCategory: category, automated: true, reasonCodes: ctx.verdict.reasonCodes, ruleSet: versionLabel(ctx.version) },
    }, tx)
    await recordDecisions(tx, [recordFor(ctx, "DECLINE", ctx.verdict.reasonCodes)])
    const run = await writeRun(tx, ctx, "DECLINED", ctx.verdict.reasonCodes, null)
    // The credit-life commit invariant is deferred: run it here, as the staff decline does.
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return { execution: "DECLINED" as const, runId: run.id, note: null }
  })
  if (result) {
    triggerNotification({ tenantId: ctx.tenantId, event: "application_declined", loanId: ctx.applicationId, clientId: ctx.loaded.application.clientId })
      .catch((error: unknown) => console.error("[auto-decision] decline notification failed:", error))
  }
  return result
}

/**
 * Approves through the staff approval path itself, as the lender's delegate
 * user: KYC, bureau, affordability, screening, open credit checks, reckless-lending
 * and compliance evidence all run exactly as for a person, and any refusal
 * turns the verdict into a referral. The engine adds nothing the path lacks.
 */
export async function approveThroughStaffPath(ctx: RunContext, delegateUserId: string | null, repaymentMethod: LoanRepaymentMethod): Promise<Executed> {
  const delegate = delegateUserId
    ? await prisma.user.findFirst({ where: { id: delegateUserId, tenantId: ctx.tenantId, active: true }, select: { id: true, email: true, role: true } })
    : null
  if (!delegate || !hasMinRole(delegate.role, "LOAN_ADMIN")) {
    return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_DELEGATE_UNAVAILABLE"], "The engine's delegate user is missing, inactive or below LOAN_ADMIN.")
  }
  const form = new FormData()
  form.set("action", "approve")
  form.set("repaymentMethod", repaymentMethod)
  form.set("reason", `Approved automatically (${versionLabel(ctx.version)})`)
  let response: Response
  try {
    response = await decideApplication({
      tenant: { id: ctx.tenantId }, user: delegate, id: ctx.applicationId, formData: form,
      automation: { ruleVersion: versionLabel(ctx.version), reasonCodes: ctx.verdict.reasonCodes, riskGrade: ctx.verdict.riskGrade },
    })
  } catch (error) {
    console.error("[auto-decision] staff approval path failed:", error)
    return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_ERROR"], "The approval path failed; staff must decide.")
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown }
    const message = typeof body.error === "string" ? body.error : `The approval path answered ${response.status}`
    return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_REFUSED"], message)
  }
  const run = await writeRun(prisma, ctx, "APPROVED", ctx.verdict.reasonCodes, null)
  return { execution: "APPROVED", runId: run.id, note: null }
}
