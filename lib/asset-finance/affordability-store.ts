import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { RegimeTx } from "./classification"
import { assessAssetFinanceAffordability } from "./affordability"
import { figureFromDb } from "./big-cents"
import { lockDeal, type DealActor } from "./deal-submit"

export type RecordAffordabilityResult =
  | { kind: "not_found" }
  | { kind: "not_editable"; status: string }
  | { kind: "financials_required" }
  | { kind: "personal_ndi_required" }
  | { kind: "note_required" }
  | { kind: "recorded"; affordable: boolean; combinedNdiAfterProposedCents: number }

export async function recordAssetFinanceAffordability(
  tx: RegimeTx,
  actor: DealActor,
  dealId: string,
  recklessLendingNote: string,
): Promise<RecordAffordabilityResult> {
  if (!(await lockDeal(tx, actor.tenantId, dealId))) return { kind: "not_found" }
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId: actor.tenantId },
    select: {
      id: true, status: true, baseInstalmentCents: true, clientId: true, entityId: true,
      application: { select: { ncaRegime: true, affordabilityNDI: true } },
      financials: { select: { turnoverCents: true, avgMonthlyCreditsCents: true, existingDebtServiceCents: true } },
      affordabilityAssessment: { select: { affordable: true, combinedNdiAfterProposedCents: true } },
    },
  })
  if (!deal) return { kind: "not_found" }
  if (!["SUBMITTED", "REFERRED"].includes(deal.status)) return { kind: "not_editable", status: deal.status }
  if (!deal.financials || deal.baseInstalmentCents === null) return { kind: "financials_required" }
  if (deal.clientId && deal.application.affordabilityNDI === null) return { kind: "personal_ndi_required" }
  const note = recklessLendingNote.trim()
  if (note.length < 10) return { kind: "note_required" }
  const result = assessAssetFinanceAffordability({
    borrower: deal.clientId ? "SOLE_PROPRIETOR" : "ENTITY",
    annualTurnoverCents: figureFromDb(deal.financials.turnoverCents),
    averageMonthlyCreditsCents: figureFromDb(deal.financials.avgMonthlyCreditsCents),
    existingDebtServiceCents: figureFromDb(deal.financials.existingDebtServiceCents),
    proposedInstalmentCents: deal.baseInstalmentCents,
    personalNdiCents: deal.clientId ? deal.application.affordabilityNDI : null,
  })
  const data = {
    verifiedBusinessIncomeCents: BigInt(result.verifiedBusinessIncomeCents),
    businessNdiBeforeProposedCents: BigInt(result.businessNdiBeforeProposedCents),
    personalNdiCents: result.personalNdiCents === null ? null : BigInt(result.personalNdiCents),
    proposedInstalmentCents: BigInt(deal.baseInstalmentCents),
    combinedNdiAfterProposedCents: BigInt(result.combinedNdiAfterProposedCents),
    affordable: result.affordable,
    recklessLendingNote: note,
    assessedById: actor.userId,
    assessedAt: new Date(),
  }
  await tx.assetFinanceAffordabilityAssessment.upsert({
    where: { dealId, tenantId: actor.tenantId },
    create: { tenantId: actor.tenantId, dealId, ...data },
    update: data,
  })
  await logAuditStrict({
    tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail,
    action: AuditAction.ASSET_AFFORDABILITY_ASSESSED, entity: "AssetFinanceDeal", entityId: dealId,
    oldValue: deal.affordabilityAssessment && {
      affordable: deal.affordabilityAssessment.affordable,
      combinedNdiAfterProposedCents: figureFromDb(deal.affordabilityAssessment.combinedNdiAfterProposedCents),
    },
    newValue: { ...result, recklessLendingNote: note },
  }, tx)
  return { kind: "recorded", affordable: result.affordable, combinedNdiAfterProposedCents: result.combinedNdiAfterProposedCents }
}
