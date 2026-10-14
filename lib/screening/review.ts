import type { ScreeningDecision, UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { REVIEW_REASON_MAX_LENGTH, REVIEW_REASON_MIN_LENGTH, getScreeningConfig } from "./policy"
import { loadLatestRun, lockClientScreening } from "./store"
import { amlStatusFor, deriveScreeningState, reviewEligibility, type ReviewRefusalCode, type ScreeningState } from "./state"

export const SCREENING_DECISIONS: readonly ScreeningDecision[] = ["FALSE_POSITIVE", "ACCEPTED", "REJECTED"]

export function isScreeningDecision(value: unknown): value is ScreeningDecision {
  return typeof value === "string" && (SCREENING_DECISIONS as readonly string[]).includes(value)
}

export type ReviewInput = {
  tenantId: string
  checkId: string
  decision: ScreeningDecision
  reason: string
  actor: { id: string; email: string; role: UserRole; totpVerified: boolean }
  /** A TOTP-free demo stack (demoStaffWithoutTotp): recorded in the audit row. */
  totpWaived: boolean
  ipAddress?: string
}

export type ReviewOutcome =
  | { ok: true; state: ScreeningState }
  | { ok: false; status: 400 | 403 | 404 | 409 | 422; code: ReviewRefusalCode | "not_found" | "superseded" | "reason_length"; error: string }

const REFUSALS: Record<ReviewRefusalCode, { status: 403 | 409 | 422; error: string }> = {
  already_decided: { status: 409, error: "This match has already been decided." },
  not_a_match: { status: 422, error: "Only a match can be reviewed." },
  sanctions_not_clearable: { status: 422, error: "A confirmed sanctions match cannot be cleared or overridden." },
  sanctions_not_acceptable: { status: 422, error: "A sanctions match cannot be accepted. Mark it a false positive, or reject it." },
  role_below_policy: { status: 403, error: "Your role is below this lender's minimum role for screening reviews." },
  totp_required: { status: 403, error: "Sign in with two-factor authentication to review a screening match." },
}

/**
 * Decides one match of the client's latest run: FALSE_POSITIVE, ACCEPTED (PEP
 * or adverse media only) or REJECTED. The decision, the client's recomputed
 * amlScreeningStatus and the audit row commit together, under the client's
 * screening lock. The DB trigger ScreeningCheck_guard_record makes it final.
 */
export async function reviewScreeningCheck(input: ReviewInput): Promise<ReviewOutcome> {
  const { tenantId, checkId, decision, actor } = input
  const reason = input.reason.trim()
  const length = [...reason].length
  if (length < REVIEW_REASON_MIN_LENGTH || length > REVIEW_REASON_MAX_LENGTH) {
    return {
      ok: false, status: 400, code: "reason_length",
      error: `Give a reason of ${REVIEW_REASON_MIN_LENGTH} to ${REVIEW_REASON_MAX_LENGTH} characters.`,
    }
  }

  const located = await prisma.screeningCheck.findFirst({
    where: { id: checkId, tenantId },
    select: { clientId: true },
  })
  if (!located) return { ok: false, status: 404, code: "not_found", error: "Screening check not found." }
  const clientId = located.clientId

  return prisma.$transaction(async (tx): Promise<ReviewOutcome> => {
    await lockClientScreening(tx, tenantId, clientId)
    // The policy as it stands now, not as the page saw it.
    await tx.$executeRaw`SELECT 1 FROM "TenantConfig" WHERE "tenantId" = ${tenantId} FOR SHARE`
    const config = await getScreeningConfig(tenantId, tx)
    const check = await tx.screeningCheck.findFirst({
      where: { id: checkId, tenantId },
      select: { id: true, runId: true, type: true, result: true, decision: true },
    })
    if (!check) return { ok: false, status: 404, code: "not_found", error: "Screening check not found." }
    const latest = await loadLatestRun(tx, tenantId, clientId)
    if (latest?.runId !== check.runId) {
      return { ok: false, status: 409, code: "superseded", error: "A newer screening run replaced this one. Review the latest run." }
    }
    const eligibility = reviewEligibility({
      check,
      decision,
      policy: config,
      caller: { role: actor.role, totpVerified: actor.totpVerified || input.totpWaived },
    })
    if (!eligibility.allowed) return { ok: false, code: eligibility.code, ...REFUSALS[eligibility.code] }

    const reviewedAt = new Date()
    const written = await tx.screeningCheck.updateMany({
      where: { id: check.id, tenantId, decision: null },
      data: { decision, decisionReason: reason, reviewedById: actor.id, reviewedAt },
    })
    if (written.count === 0) return { ok: false, code: "already_decided", ...REFUSALS.already_decided }

    const after = await loadLatestRun(tx, tenantId, clientId)
    const state = deriveScreeningState({
      configured: config.provider !== null,
      latestRun: after?.checks ?? [],
      simulationPermitted: isSimulationPermitted("screening"),
    })
    const aml = amlStatusFor(state)
    if (aml) {
      await tx.client.updateMany({ where: { id: clientId, tenantId }, data: { amlScreeningStatus: aml } })
    }
    await logAuditStrict({
      tenantId,
      userId: actor.id,
      userEmail: actor.email,
      action: AuditAction.SCREENING_MATCH_REVIEWED,
      entity: "ScreeningCheck",
      entityId: check.id,
      oldValue: { decision: null },
      newValue: {
        clientId,
        type: check.type,
        result: check.result,
        decision,
        reason,
        reviewedAt: reviewedAt.toISOString(),
        clientState: state.state,
        ...(input.totpWaived && !actor.totpVerified ? { twoFactor: "waived: demo stack without TOTP" } : {}),
      },
      ipAddress: input.ipAddress,
    }, tx)
    return { ok: true, state }
  })
}
