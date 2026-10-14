/**
 * The credit decision on an asset-finance deal (goal §4.7, decisions 2a.3
 * and 2a.6), in the caller's transaction with the application row locked
 * (./deal-submit.ts lockDeal). The route checks decide_asset_finance.
 *
 * Every decision carries reasons: at least one, each at least
 * MIN_REASON_LENGTH characters once trimmed. A deal is decidable while
 * SUBMITTED or REFERRED (its application SUBMITTED or UNDER_REVIEW).
 *
 *   APPROVE  needs the application NON_NCA (the four-eyes override applied):
 *            NCA with a PENDING NCA → NON_NCA override → awaiting_override
 *            (nothing written); NCA without one → the deal is refused as at
 *            submit (REFUSED_NCA, application DECLINED, audited). Then a
 *            credit memo (EntityFinancials) must exist. The application goes
 *            SUBMITTED → UNDER_REVIEW → APPROVED with repaymentMethod EFT,
 *            approvedAt/approvedById and the applied amount and term as
 *            approved (a NON_NCA approval needs no PASQ: CHECK
 *            LoanApplication_approved_status_requires_pasq); the deal APPROVED.
 *   DECLINE  application DECLINED (decisionReason = the reasons), deal DECLINED.
 *   REFER    application UNDER_REVIEW, deal REFERRED (decidable again).
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { RegimeTx } from "./classification"
import { hasPendingNonNcaOverride, lockDeal, type DealActor } from "./deal-submit"

export const CREDIT_DECISIONS = ["APPROVE", "DECLINE", "REFER"] as const
export type CreditDecisionValue = (typeof CREDIT_DECISIONS)[number]
export const MIN_REASON_LENGTH = 5
const MAX_REASON_LENGTH = 1000
const MAX_REASONS = 20

export interface DecideInput {
  decision: CreditDecisionValue
  reasons: string[]
}

export function parseDecideInput(body: unknown): DecideInput | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object"
  const { decision, reasons } = body as { decision?: unknown; reasons?: unknown }
  const match = CREDIT_DECISIONS.find((d) => d === decision)
  if (!match) return `decision must be one of ${CREDIT_DECISIONS.join(", ")}`
  if (!Array.isArray(reasons) || reasons.length === 0 || reasons.length > MAX_REASONS) {
    return `reasons must list 1 to ${MAX_REASONS} reasons: every decision is recorded with its reasons`
  }
  const trimmed = reasons.map((r) => (typeof r === "string" ? r.trim() : ""))
  if (trimmed.some((r) => r.length < MIN_REASON_LENGTH || r.length > MAX_REASON_LENGTH)) {
    return `each reason must be ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters`
  }
  return { decision: match, reasons: trimmed }
}

export type DecideDealResult =
  | { kind: "not_found" }
  | { kind: "not_decidable"; status: string }
  | { kind: "awaiting_override" }
  | { kind: "refused_nca"; reason: string }
  | { kind: "memo_required" }
  | { kind: "assessment_required" }
  | { kind: "unaffordable" }
  | { kind: "credit_life_required" }
  | { kind: "decided"; status: "APPROVED" | "DECLINED" | "REFERRED" }

const DECIDABLE_DEAL = ["SUBMITTED", "REFERRED"]
const DECIDABLE_APPLICATION = ["SUBMITTED", "UNDER_REVIEW"]

export async function decideDeal(tx: RegimeTx, actor: DealActor, dealId: string, input: DecideInput): Promise<DecideDealResult> {
  const { tenantId } = actor
  const applicationId = await lockDeal(tx, tenantId, dealId)
  if (!applicationId) return { kind: "not_found" }
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      id: true,
      status: true,
      applicationId: true,
      financials: { select: { dscr: true, gearing: true } },
      affordabilityAssessment: { select: { affordable: true } },
      application: { select: { status: true, ncaRegime: true, ncaClassificationRule: true, appliedAmount: true, appliedTermDays: true, creditLifeElection: true } },
    },
  })
  if (!deal) return { kind: "not_found" }
  const app = deal.application
  if (!DECIDABLE_DEAL.includes(deal.status) || !DECIDABLE_APPLICATION.includes(app.status)) {
    return { kind: "not_decidable", status: deal.status }
  }

  if (input.decision === "APPROVE") {
    if (app.ncaRegime !== "NON_NCA") {
      if (await hasPendingNonNcaOverride(tx, tenantId, applicationId)) return { kind: "awaiting_override" }
      if (!deal.affordabilityAssessment) return { kind: "assessment_required" }
      if (!deal.affordabilityAssessment.affordable) return { kind: "unaffordable" }
      if (!app.creditLifeElection) return { kind: "credit_life_required" }
    }
    if (!deal.financials) return { kind: "memo_required" }
  }

  const now = new Date()
  const decisionReason = input.reasons.join("; ")
  if (app.status === "SUBMITTED" && input.decision !== "DECLINE") {
    await tx.loanApplication.update({ where: { id: applicationId, tenantId }, data: { status: "UNDER_REVIEW" } })
  }
  let status: "APPROVED" | "DECLINED" | "REFERRED"
  switch (input.decision) {
    case "APPROVE":
      status = "APPROVED"
      await tx.loanApplication.update({
        where: { id: applicationId, tenantId },
        data: {
          status: "APPROVED",
          repaymentMethod: "EFT",
          approvedAt: now,
          approvedById: actor.userId,
          approvedAmount: app.appliedAmount,
          approvedTermDays: app.appliedTermDays,
          decisionReason,
        },
      })
      break
    case "DECLINE":
      status = "DECLINED"
      await tx.loanApplication.update({ where: { id: applicationId, tenantId }, data: { status: "DECLINED", decisionReason } })
      break
    case "REFER":
      status = "REFERRED"
      break
  }
  await tx.assetFinanceDeal.update({
    where: { id: deal.id, tenantId },
    data: { status, decision: input.decision, decisionReasons: input.reasons, decidedById: actor.userId, decidedAt: now },
  })
  await logAuditStrict(
    {
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: AuditAction.ASSET_DEAL_DECIDED,
      entity: "AssetFinanceDeal",
      entityId: deal.id,
      oldValue: { status: deal.status, applicationStatus: app.status },
      newValue: {
        status,
        decision: input.decision,
        reasons: input.reasons,
        applicationId,
        applicationStatus: status === "REFERRED" ? "UNDER_REVIEW" : status,
        ncaRegime: app.ncaRegime,
        dscr: deal.financials?.dscr?.toFixed(4) ?? null,
        gearing: deal.financials?.gearing?.toFixed(4) ?? null,
      },
    },
    tx,
  )
  return { kind: "decided", status }
}
