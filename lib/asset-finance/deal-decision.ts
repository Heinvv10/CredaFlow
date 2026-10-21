/**
 * The credit decision on an asset-finance deal (goal §4.7, decisions 2a.3
 * and 2a.6), in the caller's transaction with the application row locked
 * (./deal-submit.ts lockDeal). The route checks decide_asset_finance.
 *
 * Every decision carries reasons: at least one, each at least
 * MIN_REASON_LENGTH characters once trimmed. A deal is decidable while
 * SUBMITTED or REFERRED (its application SUBMITTED or UNDER_REVIEW).
 *
 *   APPROVE  NCA with a PENDING NCA → NON_NCA override → awaiting_override
 *            (nothing written). Otherwise an NCA deal goes down the regulated
 *            path: it needs a recorded, affordable s81 assessment and the
 *            credit-life election (the database repeats the s81 gate). Every
 *            deal needs a credit memo (EntityFinancials). A deal with
 *            exceptions (./deal-exceptions.ts: internal arrears of the
 *            borrower or its people, a director's or trustee's bureau check
 *            that was skipped, failed or went stale) needs an exception
 *            reason, bound to the fingerprint of the exceptions the approver
 *            was shown (exceptionsFingerprint): if they changed since,
 *            exceptions_changed and nothing is written. A reason sent with
 *            no exceptions is refused too. The stored reasons then carry
 *            each exception and that reason, approvalExceptions each one's
 *            key and severity (payout and booking re-check against them), audited with the
 *            decision. The product must be an ASSET_FINANCE product. The application goes
 *            SUBMITTED → UNDER_REVIEW → APPROVED with repaymentMethod EFT,
 *            approvedAt/approvedById and the applied amount and term as
 *            approved (a NON_NCA approval needs no PASQ: CHECK
 *            LoanApplication_approved_status_requires_pasq); the deal APPROVED.
 *   DECLINE  application DECLINED (decisionReason = the reasons), deal DECLINED.
 *   REFER    application UNDER_REVIEW, deal REFERRED (decidable again).
 */
import type { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { lockedBorrowerScreeningAllows } from "@/lib/screening/gate"
import type { RegimeTx } from "./classification"
import { hasPendingNonNcaOverride, lockDeal, type DealActor } from "./deal-submit"
import { loadDealExceptions } from "./deal-exceptions"
import type { RecordedException } from "./deal-exception-severity"
import { recordDecisions } from "@/lib/learning-loop/decision-log"
import { assetFinanceDecisionRecords } from "@/lib/learning-loop/records-asset-finance"

export const CREDIT_DECISIONS = ["APPROVE", "DECLINE", "REFER"] as const
export type CreditDecisionValue = (typeof CREDIT_DECISIONS)[number]
export const MIN_REASON_LENGTH = 5
const MAX_REASON_LENGTH = 1000
const MAX_REASONS = 20

export const MIN_EXCEPTION_REASON_LENGTH = 20

export interface DecideInput {
  decision: CreditDecisionValue
  reasons: string[]
  /** Why approve despite the deal's exceptions; required on APPROVE when there are any. */
  exceptionReason?: string | null
  /** The fingerprint of the exceptions the approver was shown (./deal-exceptions.ts); the reason answers exactly these. */
  exceptionsFingerprint?: string | null
}

export function parseDecideInput(body: unknown): DecideInput | string {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return "Body must be a JSON object"
  const { decision, reasons, exceptionReason, exceptionsFingerprint } = body as {
    decision?: unknown; reasons?: unknown; exceptionReason?: unknown; exceptionsFingerprint?: unknown
  }
  const match = CREDIT_DECISIONS.find((d) => d === decision)
  if (!match) return `decision must be one of ${CREDIT_DECISIONS.join(", ")}`
  if (!Array.isArray(reasons) || reasons.length === 0 || reasons.length > MAX_REASONS) {
    return `reasons must list 1 to ${MAX_REASONS} reasons: every decision is recorded with its reasons`
  }
  const trimmed = reasons.map((r) => (typeof r === "string" ? r.trim() : ""))
  if (trimmed.some((r) => r.length < MIN_REASON_LENGTH || r.length > MAX_REASON_LENGTH)) {
    return `each reason must be ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters`
  }
  if (exceptionReason !== undefined && exceptionReason !== null && typeof exceptionReason !== "string") return "exceptionReason must be text"
  const exception = typeof exceptionReason === "string" ? exceptionReason.trim() : ""
  if (exception !== "" && (exception.length < MIN_EXCEPTION_REASON_LENGTH || exception.length > MAX_REASON_LENGTH)) {
    return `the exception reason must be ${MIN_EXCEPTION_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters`
  }
  if (exceptionsFingerprint !== undefined && exceptionsFingerprint !== null
    && (typeof exceptionsFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(exceptionsFingerprint))) {
    return "exceptionsFingerprint must be the sha256 shown with the exceptions"
  }
  return {
    decision: match, reasons: trimmed, exceptionReason: exception === "" ? null : exception,
    exceptionsFingerprint: typeof exceptionsFingerprint === "string" ? exceptionsFingerprint : null,
  }
}

/** The reasons stored on an approval with exceptions: the approver's, each exception, then why it was approved anyway. */
export function reasonsWithExceptions(reasons: string[], exceptions: string[], exceptionReason: string | null): string[] {
  if (exceptions.length === 0) return reasons
  return [...reasons, ...exceptions.map((e) => `Exception: ${e}`), `Approved despite the exceptions: ${exceptionReason ?? ""}`]
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
  | { kind: "screening_blocked" }
  | { kind: "exceptions_unanswered"; exceptions: string[] }
  | { kind: "exceptions_changed"; exceptions: string[] }
  | { kind: "exception_reason_without_exceptions" }
  | { kind: "product_not_asset_finance" }
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
      application: { select: {
        clientId: true, entityId: true, status: true, ncaRegime: true, ncaClassificationRule: true, appliedAmount: true, appliedTermDays: true,
        creditLifeElection: true, product: { select: { productType: true } },
      } },
    },
  })
  if (!deal) return { kind: "not_found" }
  const app = deal.application
  if (!DECIDABLE_DEAL.includes(deal.status) || !DECIDABLE_APPLICATION.includes(app.status)) {
    return { kind: "not_decidable", status: deal.status }
  }

  let exceptions: string[] = []
  let recorded: RecordedException[] = []
  if (input.decision === "APPROVE") {
    if (app.product.productType !== "ASSET_FINANCE") return { kind: "product_not_asset_finance" }
    if (app.ncaRegime !== "NON_NCA") {
      if (await hasPendingNonNcaOverride(tx, tenantId, applicationId)) return { kind: "awaiting_override" }
      if (!deal.affordabilityAssessment) return { kind: "assessment_required" }
      if (!deal.affordabilityAssessment.affordable) return { kind: "unaffordable" }
      if (!app.creditLifeElection) return { kind: "credit_life_required" }
    }
    if (!deal.financials) return { kind: "memo_required" }
    const found = await loadDealExceptions(tx, tenantId, { applicationId, entityId: app.entityId, clientId: app.clientId })
    exceptions = found.lines
    recorded = found.recorded
    if (exceptions.length === 0 && input.exceptionReason) return { kind: "exception_reason_without_exceptions" }
    if (exceptions.length > 0 && !input.exceptionReason) return { kind: "exceptions_unanswered", exceptions }
    if (exceptions.length > 0 && input.exceptionsFingerprint !== found.fingerprint) return { kind: "exceptions_changed", exceptions }
    // PEP / sanctions screening of the borrower (the entity and its related
    // parties, or the natural person), re-read under their screening locks.
    // The route ran the gate first; the trigger LoanApplication_a1_guard_screening
    // is the backstop.
    if (!(await lockedBorrowerScreeningAllows(tx, tenantId, { clientId: app.clientId, entityId: app.entityId }, actor.userId))) {
      return { kind: "screening_blocked" }
    }
  }

  const now = new Date()
  const reasons = reasonsWithExceptions(input.reasons, exceptions, input.exceptionReason ?? null)
  const decisionReason = reasons.join("; ")
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
    data: {
      status, decision: input.decision, decisionReasons: reasons, decidedById: actor.userId, decidedAt: now,
      ...(status === "APPROVED" ? { approvalExceptions: recorded as unknown as Prisma.InputJsonArray } : {}),
    },
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
        reasons,
        ...(exceptions.length > 0 ? { exceptions, exceptionKeys: recorded.map((r) => r.key), exceptionReason: input.exceptionReason } : {}),
        applicationId,
        applicationStatus: status === "REFERRED" ? "UNDER_REVIEW" : status,
        ncaRegime: app.ncaRegime,
        dscr: deal.financials?.dscr?.toFixed(4) ?? null,
        gearing: deal.financials?.gearing?.toFixed(4) ?? null,
      },
    },
    tx,
  )
  await recordDecisions(tx, assetFinanceDecisionRecords({
    tenantId,
    dealId: deal.id,
    applicationId,
    clientId: app.clientId,
    actor: { userId: actor.userId, role: actor.role ?? null },
    decidedAt: now,
    decision: input.decision,
    ncaRegime: app.ncaRegime,
    productType: app.product.productType,
    appliedAmountCents: app.appliedAmount,
    appliedTermDays: app.appliedTermDays,
    dscr: deal.financials?.dscr?.toNumber() ?? null,
    gearing: deal.financials?.gearing?.toNumber() ?? null,
    creditMemo: deal.financials !== null,
    s81Affordable: deal.affordabilityAssessment?.affordable ?? null,
    exceptionKinds: recorded.map((r) => r.kind),
    exceptionsFingerprint: exceptions.length > 0 ? input.exceptionsFingerprint ?? null : null,
    exceptionReason: input.exceptionReason ?? null,
  }))
  return { kind: "decided", status }
}
