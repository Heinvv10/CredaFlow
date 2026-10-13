/**
 * Records a deal's credit memo (EntityFinancials) and its ratios, in the
 * caller's transaction with the application row locked, so a memo cannot
 * change underneath a decision. Editable while the deal is DRAFT, SUBMITTED
 * or REFERRED. DSCR uses the deal's own schedule, solved as on the deal page
 * (./deal-terms.ts); the formulas are in ./credit-memo.ts.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { RegimeTx } from "./classification"
import { computeCreditMemo, type CreditMemoRatios } from "./credit-memo"
import type { CreditMemoInput } from "./credit-memo-input"
import { lockDeal, type DealActor } from "./deal-submit"
import { DEAL_STRUCTURE_SELECT, solveStoredDeal } from "./deal-terms"
import { dbDate } from "./rates-store"

export const MEMO_EDITABLE_STATUSES = ["DRAFT", "SUBMITTED", "REFERRED"]

export type RecordFinancialsResult =
  | { kind: "not_found" }
  | { kind: "not_editable"; status: string }
  | { kind: "schedule_unavailable"; error: string }
  | { kind: "recorded"; ratios: CreditMemoRatios }

export async function recordDealFinancials(
  tx: RegimeTx,
  actor: DealActor,
  dealId: string,
  input: CreditMemoInput,
): Promise<RecordFinancialsResult> {
  const { tenantId } = actor
  if (!(await lockDeal(tx, tenantId, dealId))) return { kind: "not_found" }
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: dealId, tenantId },
    select: {
      id: true,
      status: true,
      ...DEAL_STRUCTURE_SELECT,
      asset: { select: { cashPriceExclVatCents: true, vatCents: true } },
      financials: { select: { dscr: true, gearing: true } },
    },
  })
  if (!deal) return { kind: "not_found" }
  if (!MEMO_EDITABLE_STATUSES.includes(deal.status)) return { kind: "not_editable", status: deal.status }

  const solved = await solveStoredDeal(tx, tenantId, deal, deal.asset)
  if (!solved.ok) return { kind: "schedule_unavailable", error: solved.error }
  const ratios = computeCreditMemo(input, solved.result.rows)

  const data = {
    periodEnd: dbDate(input.periodEnd),
    turnoverCents: BigInt(input.turnoverCents),
    ebitdaCents: BigInt(input.ebitdaCents),
    totalAssetsCents: BigInt(input.totalAssetsCents),
    totalLiabilitiesCents: BigInt(input.totalLiabilitiesCents),
    existingDebtServiceCents: BigInt(input.existingDebtServiceCents),
    avgMonthlyCreditsCents: BigInt(input.avgMonthlyCreditsCents),
    returnedDebitsCount: input.returnedDebitsCount,
    dscr: ratios.dscr,
    gearing: ratios.gearing,
    notes: input.notes,
    preparedById: actor.userId,
  }
  await tx.entityFinancials.upsert({
    where: { dealId: deal.id, tenantId },
    create: { tenantId, dealId: deal.id, ...data },
    update: data,
  })
  await logAuditStrict(
    {
      tenantId,
      userId: actor.userId,
      userEmail: actor.userEmail,
      action: AuditAction.ENTITY_FINANCIALS_RECORDED,
      entity: "AssetFinanceDeal",
      entityId: deal.id,
      oldValue: deal.financials && {
        dscr: deal.financials.dscr?.toFixed(4) ?? null,
        gearing: deal.financials.gearing?.toFixed(4) ?? null,
      },
      newValue: { ...input, ...ratios },
    },
    tx,
  )
  return { kind: "recorded", ratios }
}
