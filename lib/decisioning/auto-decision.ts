import type { AutoDecisionExecution, AutoDecisionRole, DecisionRuleSetVersion } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { approveThroughStaffPath, declineAutomatically, recordShadow, refer, type Executed, type RunContext } from "./auto-actions"
import { decide } from "./decide"
import { loadDecisionFacts } from "./load-facts"
import { versionLabel } from "./records"
import { inChallengerGroup, pickChampion } from "./select-version"
import type { Verdict } from "./types"
import { parseRules } from "./validate-rules"
import { parseScorecard } from "./validate-scorecard"

export const TRIGGERS = ["REVIEW_STARTED", "MANUAL"] as const
export type Trigger = (typeof TRIGGERS)[number]

export type SkipReason =
  | "engine_off"
  | "not_a_consumer_application"
  | "not_under_review"
  | "channel_not_enabled"
  | "product_not_enabled"
  | "no_rule_set"
  | "rule_set_invalid"

export type AutoDecisionOutcome =
  | { status: "SKIPPED"; reason: SkipReason }
  | {
      status: "RAN"
      runId: string
      execution: AutoDecisionExecution
      verdict: Verdict
      role: AutoDecisionRole
      ruleSet: string
      latencyMs: number
      note: string | null
    }

const skipped = (reason: SkipReason): AutoDecisionOutcome => ({ status: "SKIPPED", reason })
const day = (d: Date) => d.toISOString().slice(0, 10)
const ref = (v: DecisionRuleSetVersion) => ({ id: v.id, scopeKey: v.scopeKey, version: v.version, effectiveFrom: day(v.effectiveFrom), challengerOnly: v.challengerOnly })

/** Records the grade on the application (the contract in ./risk-grade.ts), once per change. */
async function writeGrade(ctx: Pick<RunContext, "tenantId" | "applicationId" | "now" | "version">, verdict: Verdict): Promise<void> {
  if (verdict.riskGrade === null) return
  const current = await prisma.loanApplication.findFirst({ where: { id: ctx.applicationId, tenantId: ctx.tenantId }, select: { riskGrade: true, riskScore: true } })
  if (current?.riskGrade === verdict.riskGrade && current.riskScore === verdict.score) return
  const updated = await prisma.loanApplication.updateMany({
    where: { id: ctx.applicationId, tenantId: ctx.tenantId, status: "UNDER_REVIEW" },
    data: { riskGrade: verdict.riskGrade, riskScore: verdict.score, riskGradedAt: ctx.now },
  })
  if (updated.count === 1) {
    await logAuditStrict({
      tenantId: ctx.tenantId, action: AuditAction.APPLICATION_RISK_GRADED, entity: "LoanApplication", entityId: ctx.applicationId,
      oldValue: { riskGrade: current?.riskGrade ?? null }, newValue: { riskGrade: verdict.riskGrade, riskScore: verdict.score, ruleSet: versionLabel(ctx.version) },
    })
  }
}

/**
 * Runs the lender's decision engine on one application under review and, in
 * LIVE mode, acts on the verdict: a decline is booked by the engine, an
 * approval goes through the staff approval path (every hard gate applies), a
 * referral leaves the application for staff. OFF does nothing; SHADOW grades
 * and records only. Throws only on infrastructure failure: callers treat a
 * throw as "left for staff".
 */
export async function runAutoDecision(input: { tenantId: string; applicationId: string; trigger: Trigger; now?: Date }): Promise<AutoDecisionOutcome> {
  const startedAt = performance.now()
  const { tenantId, applicationId, trigger } = input
  const now = input.now ?? new Date()
  return runWithTenant(tenantId, async () => {
    const config = await prisma.decisionEngineConfig.findUnique({ where: { tenantId } })
    if (!config || config.mode === "OFF") return skipped("engine_off")

    const loaded = await loadDecisionFacts(prisma, tenantId, applicationId, now)
    if (!loaded) return skipped("not_a_consumer_application")
    if (loaded.application.status !== "UNDER_REVIEW") return skipped("not_under_review")
    if (!config.channels.includes(loaded.facts.channel)) return skipped("channel_not_enabled")
    if (!config.productIds.includes(loaded.application.productId)) return skipped("product_not_enabled")

    const rows = await prisma.decisionRuleSetVersion.findMany({ where: { tenantId, scopeKey: { in: [loaded.application.productId, "ALL"] } } })
    const champion = pickChampion(rows.map(ref), loaded.application.productId, sastCalendarDate(now))
    const challenger = config.challengerVersionId && config.challengerPercent > 0
      ? await prisma.decisionRuleSetVersion.findFirst({ where: { id: config.challengerVersionId, tenantId } })
      : null
    const challengerApplies = challenger !== null
      && (challenger.scopeKey === "ALL" || challenger.scopeKey === loaded.application.productId)
      && inChallengerGroup(applicationId, challenger.id, config.challengerPercent)
    const row = challengerApplies ? challenger : rows.find((r) => r.id === champion?.id)
    if (!row) return skipped("no_rule_set")
    const role: AutoDecisionRole = challengerApplies ? "CHALLENGER" : "CHAMPION"

    let verdict: Verdict
    try {
      verdict = decide({ facts: loaded.facts, rules: parseRules(row.rules), scorecard: parseScorecard(row.scorecard) })
    } catch (error) {
      // A stored set that no longer validates is never run: staff decide.
      console.error("[auto-decision] stored rule set is invalid:", row.id, error)
      return skipped("rule_set_invalid")
    }

    const ctx: RunContext = {
      tenantId, applicationId, trigger, mode: config.mode, role, loaded, verdict, startedAt, now,
      version: { id: row.id, scopeKey: row.scopeKey, version: row.version },
    }
    await writeGrade(ctx, verdict)

    let done: Executed | null
    if (config.mode === "SHADOW") done = await recordShadow(ctx)
    else if (verdict.decision === "DECLINE") done = await declineAutomatically(ctx)
    else if (verdict.decision === "REFER") done = await refer(ctx, verdict.reasonCodes, null)
    else done = await approveThroughStaffPath(ctx, config.delegateUserId, config.repaymentMethod)
    if (!done) return skipped("not_under_review")

    return {
      status: "RAN", runId: done.runId, execution: done.execution, verdict, role, ruleSet: versionLabel(ctx.version),
      latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), note: done.note,
    }
  })
}
