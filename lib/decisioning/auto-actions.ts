import type { AutoDecisionExecution, AutoDecisionRole, DecisionEngineMode, LoanRepaymentMethod } from "@prisma/client"
import { decideApplication, type DecideAutomation } from "@/app/api/applications/[id]/decide/decide-application"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { logger } from "@/lib/observability/logger"
import { recordDecisions } from "@/lib/learning-loop/decision-log"
import { prisma } from "@/lib/prisma"
import type { LoadedFacts } from "./load-facts"
import { referRecord, versionLabel } from "./records"
import { findSystemUser } from "./system-user"
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
  /** What the rules said, whatever was then done with it. */
  verdict: Verdict
  /** The lender's approved client notice at the time of the run (null until signed off); stored on a DECLINED run. */
  noticeText?: string | null
  startedAt: number
  now: Date
}

export interface Executed {
  execution: AutoDecisionExecution
  runId: string
  note: string | null
}

/** The application changed (or left review) between the facts being read and the decision: the engine stands down. */
export class ApplicationChangedError extends Error {
  constructor() {
    super("The application changed after the decision engine read it")
    this.name = "ApplicationChangedError"
  }
}

/** The lender's s71 sign-off was gone when the decline came to commit: the decline must not stand. */
export class S71NotSignedOffError extends Error {
  constructor() {
    super("The lender's POPIA s71 sign-off of automated declines is not in force")
    this.name = "S71NotSignedOffError"
  }
}

/**
 * The sign-off and the wording as they are NOW, read inside the decline's transaction with a row lock
 * (FOR SHARE: a change of the engine settings waits for this decline to commit), so a decline is never
 * committed under a sign-off that was withdrawn or reworded after the verdict was made.
 */
async function currentNotice(tx: Pick<Tx, "$queryRaw">, tenantId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ s71SignedOffAt: Date | null; automatedDeclineNotice: string | null }>>`
    SELECT "s71SignedOffAt", "automatedDeclineNotice" FROM "DecisionEngineConfig" WHERE "tenantId" = ${tenantId} FOR SHARE`
  const config = rows[0]
  if (!config?.s71SignedOffAt) throw new S71NotSignedOffError()
  return config.automatedDeclineNotice
}

const elapsed = (ctx: RunContext) => Math.max(0, Math.round(performance.now() - ctx.startedAt))

/** Submission to this decision, for an application the client submitted themselves (the 60-second digital target). */
function submissionLatencyMs(ctx: RunContext): number | null {
  const submittedAt = ctx.loaded.application.submittedAt
  if (!submittedAt || ctx.loaded.facts.channel === "STAFF") return null
  return Math.max(0, ctx.now.getTime() - submittedAt.getTime() + elapsed(ctx))
}

/** The engine's own record of a run: always written in the same transaction as what it did. */
export function writeRun(tx: Pick<Tx, "autoDecisionRun">, ctx: RunContext, execution: AutoDecisionExecution, reasonCodes: readonly string[], note: string | null) {
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
      submissionLatencyMs: submissionLatencyMs(ctx),
      noticeText: execution === "DECLINED" ? (ctx.noticeText ?? null) : null,
    },
    select: { id: true },
  })
}

/**
 * Records the grade on the application (the contract in ./risk-grade.ts) inside
 * the caller's transaction, with its audit row. LIVE only: a SHADOW run records
 * its grade on the run alone, because pricing must not move on a rehearsal.
 * `lock` also requires the application to be as the facts were read.
 */
export async function writeGrade(tx: Pick<Tx, "loanApplication" | "auditLog">, ctx: RunContext, lock: boolean): Promise<void> {
  const { verdict } = ctx
  if (verdict.riskGrade === null || verdict.gradeRank === null) return
  const changed = await tx.loanApplication.updateMany({
    where: { id: ctx.applicationId, tenantId: ctx.tenantId, ...(lock ? { updatedAt: ctx.loaded.application.updatedAt, status: "UNDER_REVIEW" as const } : {}) },
    data: {
      riskGrade: verdict.riskGrade,
      riskScore: verdict.score,
      riskGradedAt: ctx.now,
      riskGradeVersionId: ctx.version.id,
      riskGradeRank: verdict.gradeRank,
      riskPricingTier: verdict.pricingTier,
    },
  })
  if (changed.count !== 1) throw new ApplicationChangedError()
  await logAuditStrict({
    tenantId: ctx.tenantId, action: AuditAction.APPLICATION_RISK_GRADED, entity: "LoanApplication", entityId: ctx.applicationId,
    newValue: { riskGrade: verdict.riskGrade, riskScore: verdict.score, ruleSet: versionLabel(ctx.version), role: ctx.role },
  }, tx as never)
}

/** SHADOW: the verdict is recorded on the run and acted on by no one; the application is not touched. */
export async function recordShadow(ctx: RunContext): Promise<Executed> {
  const run = await writeRun(prisma, ctx, "NOT_ACTED", ctx.verdict.reasonCodes, null)
  return { execution: "NOT_ACTED", runId: run.id, note: null }
}

/**
 * The application stays UNDER_REVIEW for staff, with the codes that sent it
 * there. The grade, the decision-log record, the audit row and the run commit
 * together. `lock`: the application must be exactly as the facts were read (a
 * plain referral); a referral after the staff path refused is not locked, because
 * that path's own checks may have touched the row.
 */
export async function refer(ctx: RunContext, reasonCodes: readonly string[], note: string | null, lock = true): Promise<Executed> {
  return prisma.$transaction(async (tx) => {
    await writeGrade(tx, ctx, lock)
    await recordDecisions(tx, [referRecord({
      tenantId: ctx.tenantId, applicationId: ctx.applicationId, clientId: ctx.loaded.application.clientId, reasonCodes,
      riskGrade: ctx.verdict.riskGrade, role: ctx.role, version: ctx.version, bureauCheckId: ctx.loaded.bureauCheckId,
      facts: ctx.loaded.facts, decidedAt: ctx.now,
    })])
    await logAuditStrict({
      tenantId: ctx.tenantId, action: AuditAction.AUTO_DECISION_REFERRED, entity: "LoanApplication", entityId: ctx.applicationId,
      newValue: { reasonCodes: [...reasonCodes], ruleSet: versionLabel(ctx.version), role: ctx.role, riskGrade: ctx.verdict.riskGrade },
    }, tx)
    const run = await writeRun(tx, ctx, "REFERRED", reasonCodes, note)
    return { execution: "REFERRED" as const, runId: run.id, note }
  })
}

/** Collects what the in-transaction hook wrote, so the caller can report the run that committed. */
interface Booked { runId: string }

function automationFor(ctx: RunContext, execution: AutoDecisionExecution, reasonCodes: readonly string[], booked: Booked): DecideAutomation {
  const { productId: _productId, productCode: _productCode, ...exactInputs } = ctx.loaded.facts
  return {
    ruleVersion: versionLabel(ctx.version),
    ruleSetVersionId: ctx.version.id,
    reasonCodes,
    riskGrade: ctx.verdict.riskGrade,
    riskGradeRank: ctx.verdict.gradeRank,
    bureauCheckId: ctx.loaded.bureauCheckId,
    exactInputs,
    expectedUpdatedAt: ctx.loaded.application.updatedAt,
    inTransaction: async (tx) => {
      await writeGrade(tx, ctx, false)
      // A decline stores the wording in force when it commits, not the one read when the verdict was made.
      const decided = execution === "DECLINED" ? { ...ctx, noticeText: await currentNotice(tx, ctx.tenantId) } : ctx
      booked.runId = (await writeRun(tx, decided, execution, reasonCodes, null)).id
    },
  }
}

/** The staff path's answer to the engine: a refusal of the verdict, or "the application moved on" (then nothing is decided). */
async function refusalOf(response: Response): Promise<{ applicationChanged: boolean; message: string }> {
  const body = (await response.json().catch(() => ({}))) as { error?: unknown; applicationChanged?: unknown }
  return {
    applicationChanged: body.applicationChanged === true,
    message: typeof body.error === "string" ? body.error : `The decision path answered ${response.status}`,
  }
}

/**
 * Declines through the staff decline path itself, as the lender's system user:
 * the same optimistic lock on the application, the same 409 handling, the same
 * audit row, decision log record (flagged for the lender's POPIA s71 review),
 * client wording and notification as a person's decline. Null: the application
 * changed first, so nothing was declined.
 */
export async function declineThroughStaffPath(ctx: RunContext): Promise<Executed | null> {
  const system = await findSystemUser(prisma, ctx.tenantId)
  if (!system) return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_SYSTEM_USER_MISSING"], "The decision engine's system user is missing; staff must decide.", false)
  const booked: Booked = { runId: "" }
  const form = new FormData()
  form.set("action", "decline")
  form.set("declineCategory", ctx.verdict.declineCategory ?? "POLICY")
  form.set("reason", "")
  form.set("internalNote", `Automatic decision (${versionLabel(ctx.version)}): ${ctx.verdict.reasonCodes.join(", ")}`)
  let response: Response
  try {
    response = await decideApplication({ tenant: { id: ctx.tenantId }, user: system, id: ctx.applicationId, formData: form, automation: automationFor(ctx, "DECLINED", ctx.verdict.reasonCodes, booked) })
  } catch (error) {
    if (error instanceof S71NotSignedOffError) return refer(ctx, [...ctx.verdict.reasonCodes, "S71_NOT_SIGNED_OFF"], "The s71 sign-off of automated declines is no longer in force; staff must decide.", false)
    logger.error("auto-decision: staff decline path failed", { applicationId: ctx.applicationId, error: error instanceof Error ? error.message : String(error) })
    return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_ERROR"], "The decline path failed; staff must decide.", false)
  }
  if (response.ok) return { execution: "DECLINED", runId: booked.runId, note: null }
  const refusal = await refusalOf(response)
  if (refusal.applicationChanged) return null
  return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_REFUSED"], refusal.message, false)
}

/**
 * Approves through the staff approval path itself, as the lender's system user:
 * KYC, bureau, affordability, screening, open credit checks, reckless-lending and
 * compliance evidence all run exactly as for a person, and any refusal (or
 * failure) turns the verdict into a referral. The engine adds nothing the path
 * lacks. Null: the application changed first.
 */
export async function approveThroughStaffPath(ctx: RunContext, repaymentMethod: LoanRepaymentMethod): Promise<Executed | null> {
  const system = await findSystemUser(prisma, ctx.tenantId)
  if (!system) return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_SYSTEM_USER_MISSING"], "The decision engine's system user is missing; staff must decide.", false)
  const booked: Booked = { runId: "" }
  const form = new FormData()
  form.set("action", "approve")
  form.set("repaymentMethod", repaymentMethod)
  form.set("reason", `Approved automatically (${versionLabel(ctx.version)})`)
  let response: Response
  try {
    response = await decideApplication({ tenant: { id: ctx.tenantId }, user: system, id: ctx.applicationId, formData: form, automation: automationFor(ctx, "APPROVED", ctx.verdict.reasonCodes, booked) })
  } catch (error) {
    logger.error("auto-decision: staff approval path failed", { applicationId: ctx.applicationId, error: error instanceof Error ? error.message : String(error) })
    return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_ERROR"], "The approval path failed; staff must decide.", false)
  }
  if (response.ok) return { execution: "APPROVED", runId: booked.runId, note: null }
  const refusal = await refusalOf(response)
  if (refusal.applicationChanged) return null
  return refer(ctx, [...ctx.verdict.reasonCodes, "HARD_GATE_REFUSED"], refusal.message, false)
}
