import type { AutoDecisionExecution, AutoDecisionRole, DecisionRuleSetVersion } from "@prisma/client"
import { AuditAction, logAudit } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { ApplicationChangedError, approveThroughStaffPath, declineThroughStaffPath, recordShadow, refer, type Executed, type RunContext } from "./auto-actions"
import { decide } from "./decide"
import { loadDecisionFacts } from "./load-facts"
import { versionLabel } from "./records"
import { inChallengerGroup, pickChampion } from "./select-version"
import type { Verdict } from "./types"
import { parseRules } from "./validate-rules"
import { parseScorecard } from "./validate-scorecard"

export const TRIGGERS = ["REVIEW_STARTED", "DIGITAL_SUBMISSION", "MANUAL"] as const
export type Trigger = (typeof TRIGGERS)[number]

export const REASON_S71_NOT_SIGNED_OFF = "S71_NOT_SIGNED_OFF"

export type SkipReason =
  | "engine_off"
  | "not_a_consumer_application"
  | "not_under_review"
  | "channel_not_enabled"
  | "product_not_enabled"
  | "no_rule_set"
  | "rule_set_invalid"
  | "application_changed"
  | "human_review_requested"

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

/**
 * Runs the lender's decision engine on one application under review and, in
 * LIVE mode, acts on the verdict: a decline is booked by the staff decline
 * path, an approval by the staff approval path (every hard gate applies), a
 * referral leaves the application for staff. OFF does nothing; SHADOW records
 * the run only (no grade on the application, no decision). A decline waits for
 * the lender's POPIA s71 sign-off: until it is set the verdict is referred.
 * Throws only on infrastructure failure: callers treat a throw as "left for staff".
 */
export async function runAutoDecision(input: { tenantId: string; applicationId: string; trigger: Trigger; now?: Date }): Promise<AutoDecisionOutcome> {
  const startedAt = performance.now()
  const { tenantId, applicationId, trigger } = input
  const now = input.now ?? new Date()
  return runWithTenant(tenantId, async () => {
    const config = await prisma.decisionEngineConfig.findUnique({ where: { tenantId } })
    if (!config || config.mode === "OFF") return skipped("engine_off")

    // A shadow rehearsal on a digital submission runs before anyone has started a review: it reads the
    // application as it is (SUBMITTED), from bureau data already on file, and changes nothing.
    const rehearsal = config.mode === "SHADOW" && trigger === "DIGITAL_SUBMISSION"
    const loaded = await loadDecisionFacts(prisma, tenantId, applicationId, now, rehearsal ? { existingBureauOnly: true } : {})
    if (!loaded) return skipped("not_a_consumer_application")
    // A person was asked to look again: from then on the engine decides nothing about this application.
    if (loaded.application.humanReviewRequestedAt) return skipped("human_review_requested")
    if (loaded.application.status !== "UNDER_REVIEW" && !(rehearsal && loaded.application.status === "SUBMITTED")) return skipped("not_under_review")
    if (!config.channels.includes(loaded.facts.channel)) return skipped("channel_not_enabled")
    if (!config.productIds.includes(loaded.application.productId)) return skipped("product_not_enabled")

    const today = sastCalendarDate(now)
    const rows = await prisma.decisionRuleSetVersion.findMany({ where: { tenantId, scopeKey: { in: [loaded.application.productId, "ALL"] } } })
    const champion = pickChampion(rows.map(ref), loaded.application.productId, today)
    const challenger = config.challengerVersionId && config.challengerPercent > 0
      ? await prisma.decisionRuleSetVersion.findFirst({ where: { id: config.challengerVersionId, tenantId } })
      : null
    // A challenger is a version like any other: it decides only from its effective date, for its own scope.
    const challengerApplies = challenger !== null
      && day(challenger.effectiveFrom) <= today
      && (challenger.scopeKey === "ALL" || challenger.scopeKey === loaded.application.productId)
      && inChallengerGroup(applicationId, challenger.id, config.challengerPercent)
    const row = challengerApplies ? challenger : rows.find((r) => r.id === champion?.id)
    if (!row) return skipped("no_rule_set")
    const role: AutoDecisionRole = challengerApplies ? "CHALLENGER" : "CHAMPION"

    let verdict: Verdict
    try {
      verdict = decide({ facts: loaded.facts, rules: parseRules(row.rules), scorecard: parseScorecard(row.scorecard) })
    } catch (error) {
      // A stored set that no longer validates is never run: staff decide. Say so where operations will see it.
      // TODO: use the structured logger once lib/observability/logger.ts lands (PR #252).
      console.error("[auto-decision] stored rule set is invalid:", row.id, error)
      await logAudit({
        tenantId, action: AuditAction.AUTO_DECISION_RULE_SET_INVALID, entity: "DecisionRuleSetVersion", entityId: row.id,
        newValue: { applicationId, mode: config.mode, ruleSet: versionLabel(row), role },
      })
      return skipped("rule_set_invalid")
    }

    // No bureau data to rehearse on: say so, rather than score an applicant nobody checked.
    if (rehearsal && !loaded.bureauCheckId) {
      verdict = { ...verdict, decision: "REFER", reasonCodes: ["NO_BUREAU"], declineCategory: null, riskGrade: null, gradeRank: null, score: null, pricingTier: null, hits: [] }
    }
    const ctx: RunContext = {
      tenantId, applicationId, trigger, mode: config.mode, role, loaded, verdict, startedAt, now,
      noticeText: config.s71SignedOffAt ? config.automatedDeclineNotice : null,
      version: { id: row.id, scopeKey: row.scopeKey, version: row.version },
    }
    try {
      let done: Executed | null
      if (config.mode === "SHADOW") done = await recordShadow(ctx)
      else if (verdict.decision === "DECLINE" && config.s71SignedOffAt === null) {
        done = await refer(ctx, [...verdict.reasonCodes, REASON_S71_NOT_SIGNED_OFF], "Automated declines are not yet signed off by the lender's legal team (POPIA s71); staff must decide.")
      } else if (verdict.decision === "DECLINE") done = await declineThroughStaffPath(ctx)
      else if (verdict.decision === "REFER") done = await refer(ctx, verdict.reasonCodes, null)
      else done = await approveThroughStaffPath(ctx, config.repaymentMethod)
      if (!done) return skipped("application_changed")
      return {
        status: "RAN", runId: done.runId, execution: done.execution, verdict, role, ruleSet: versionLabel(ctx.version),
        latencyMs: Math.max(0, Math.round(performance.now() - startedAt)), note: done.note,
      }
    } catch (error) {
      if (error instanceof ApplicationChangedError) return skipped("application_changed")
      throw error
    }
  })
}
