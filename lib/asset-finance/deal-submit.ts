/**
 * Submitting an asset-finance deal (goal §4.7, decision 2a.6), in the
 * caller's transaction. The deal's application row is locked first, as
 * classification and override decisions lock it (./classification.ts), so
 * submit, decide and override decisions serialise per deal.
 *
 *   1. classifyApplication runs as the submitting user while the application
 *      is still DRAFT. Its result is never NON_NCA directly: a NON_NCA result
 *      leaves the application NCA with a PENDING override for a second
 *      approver.
 *   2. The application moves DRAFT → SUBMITTED and the deal → SUBMITTED.
 *   3. NCA applications proceed down the regulated asset-finance path. A
 *      natural person is already stamped NATURAL_PERSON_NCA at creation and
 *      deliberately skips the juristic-person classifier.
 *   4. A lease (operating or full-maintenance) skips the classifier too: its
 *      application was written NON_NCA / LEASE_NOT_CREDIT_AGREEMENT
 *      (./lease-deal.ts). Its CPA scope is re-run here on the lessee's
 *      current financials, and frozen once the deal is approved.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { classifyApplication, lockApplicationForRegime, type RegimeTx } from "./classification"
import { ncaRuleLabel } from "./labels"
import { isLeaseContract } from "./lease-input"
import { cpaColumns, leaseCpaScope } from "./lease-deal"

export interface DealActor {
  tenantId: string
  userId: string
  userEmail?: string
  /** The staff role, recorded in the decision log (lib/learning-loop/). */
  role?: string
}

/** The decision reason stored on a refused NCA deal's application, in plain English (the rule's label, never its id). */
export function ncaRefusalReason(rule: string | null): string {
  return `NCA applies (${rule === null ? "not classified" : ncaRuleLabel(rule)})`
}

/** The deal's applicationId, with that application row locked for the transaction. */
export async function lockDeal(tx: RegimeTx, tenantId: string, dealId: string): Promise<string | null> {
  const deal = await tx.assetFinanceDeal.findFirst({ where: { id: dealId, tenantId }, select: { applicationId: true } })
  if (!deal) return null
  return (await lockApplicationForRegime(tx, tenantId, deal.applicationId)) ? deal.applicationId : null
}

export async function hasPendingNonNcaOverride(tx: RegimeTx, tenantId: string, applicationId: string): Promise<boolean> {
  const pending = await tx.ncaRegimeOverride.findFirst({
    where: { tenantId, applicationId, status: "PENDING", toRegime: "NON_NCA" },
    select: { id: true },
  })
  return pending !== null
}

/** Refuse an NCA deal: deal REFUSED_NCA, application DECLINED with the reason; audited. */
export async function refuseNcaDeal(
  tx: RegimeTx,
  actor: DealActor,
  deal: { id: string; status: string; applicationId: string },
  rule: string | null,
  extra: { submittedAt?: Date } = {},
): Promise<string> {
  const reason = ncaRefusalReason(rule)
  await tx.loanApplication.update({
    where: { id: deal.applicationId, tenantId: actor.tenantId },
    data: { status: "DECLINED", decisionReason: reason, ...extra },
  })
  await tx.assetFinanceDeal.update({ where: { id: deal.id, tenantId: actor.tenantId }, data: { status: "REFUSED_NCA" } })
  await logAuditStrict(
    {
      tenantId: actor.tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: AuditAction.ASSET_DEAL_REFUSED_NCA,
      entity: "AssetFinanceDeal",
      entityId: deal.id,
      oldValue: { status: deal.status },
      newValue: { status: "REFUSED_NCA", applicationId: deal.applicationId, applicationStatus: "DECLINED", ncaRegime: "NCA", rule, reason },
    },
    tx,
  )
  return reason
}

export type SubmitDealResult =
  | { kind: "not_found" }
  | { kind: "not_draft"; status: string }
  | { kind: "regime_frozen"; status: string }
  | { kind: "submitted"; awaitingRegimeApproval: boolean; regime: "NCA" | "NON_NCA"; rule: string }
  | { kind: "refused_nca"; reason: string; rule: string }

export async function submitDeal(tx: RegimeTx, actor: DealActor, dealId: string): Promise<SubmitDealResult> {
  const { tenantId } = actor
  const applicationId = await lockDeal(tx, tenantId, dealId)
  if (!applicationId) return { kind: "not_found" }
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      id: true, status: true, applicationId: true, contractType: true, clientId: true, entityId: true,
      application: { select: { status: true, clientId: true, entityId: true, ncaRegime: true, ncaClassificationRule: true } },
    },
  })
  if (!deal) return { kind: "not_found" }
  if (deal.status !== "DRAFT" || deal.application.status !== "DRAFT") {
    return { kind: "not_draft", status: deal.status === "DRAFT" ? deal.application.status : deal.status }
  }

  const lease = isLeaseContract(deal.contractType)
  const cpa = (lease || deal.contractType === "INSTALMENT_SALE") ? await leaseCpaScope(tx, tenantId, deal) : null
  if (lease && !cpa) return { kind: "not_found" }
  const classified = deal.application.clientId || lease
    ? null
    : await classifyApplication(tx, { tenantId, applicationId, userId: actor.userId, userEmail: actor.userEmail })
  if (classified?.kind === "not_found" || classified?.kind === "not_entity_borrower") return { kind: "not_found" }
  if (classified?.kind === "regime_frozen") return { kind: "regime_frozen", status: classified.status }
  const rule = classified?.classification.rule ?? deal.application.ncaClassificationRule ?? "NATURAL_PERSON_NCA"
  const regime = classified?.regime ?? (lease ? "NON_NCA" : "NCA")
  const submittedAt = new Date()
  const awaitingRegimeApproval =
    regime === "NCA" && !deal.application.clientId && (await hasPendingNonNcaOverride(tx, tenantId, applicationId))

  await logAuditStrict(
    {
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: AuditAction.ASSET_DEAL_SUBMITTED,
      entity: "AssetFinanceDeal",
      entityId: deal.id,
      oldValue: { status: "DRAFT" },
      newValue: {
        applicationId,
        ncaRegime: regime,
        classifierRegime: classified?.classification.regime ?? null,
        rule,
        pendingOverrideId: classified?.pendingOverrideId ?? null,
        awaitingRegimeApproval,
        ...(cpa ? { cpaApplies: cpa.applies, cpaRule: cpa.rule, cpaEvidenceIds: cpa.evidenceIds } : {}),
      },
    },
    tx,
  )

  await tx.loanApplication.update({
    where: { id: applicationId, tenantId },
    data: { status: "SUBMITTED", submittedAt },
  })
  await tx.assetFinanceDeal.update({ where: { id: deal.id, tenantId }, data: { status: "SUBMITTED", ...(lease && cpa ? cpaColumns(cpa) : {}), ...(deal.contractType === "INSTALMENT_SALE" && cpa ? { isaCpaApplies: cpa.applies, isaCpaRule: cpa.rule } : {}) } })
  return { kind: "submitted", awaitingRegimeApproval, regime, rule }
}
