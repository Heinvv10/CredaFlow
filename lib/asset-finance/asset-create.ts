/**
 * Register a financed asset with its audit row in one transaction: the staff
 * route (POST /api/asset-finance/assets) and the dealer portal
 * (lib/dealer/capture.ts) both come here. A dealer's asset carries
 * createdByDealerId.
 *
 * The VAT must be the VAT on the exclusive cash price at the rate in force
 * today (the database checks it too). A serial number or VIN already on an
 * unreleased asset of this lender, as either, is refused by the database
 * (DESIGN D8); the attempt is audited outside the aborted transaction and
 * reported, never shown.
 */
import type { FinancedAsset } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { sastCalendarDate } from "@/lib/date/sast"
import { loadRateOn } from "@/lib/vat/vat-rate"
import { duplicateAssetMessage, vatProblem, type AssetFields } from "./asset-input"
import { originationAudit, originationColumns, originationTenant, type OriginationActor } from "./origination-actor"

export type CreateAssetResult =
  | { kind: "created"; asset: FinancedAsset }
  | { kind: "invalid"; fields: Record<string, string> }
  | { kind: "duplicate"; message: string }

export async function createFinancedAsset(by: OriginationActor, data: AssetFields): Promise<CreateAssetResult> {
  const tenantId = originationTenant(by)
  const audit = originationAudit(by)
  const problem = vatProblem(data.cashPriceExclVatCents, data.vatCents, (await loadRateOn(prisma, sastCalendarDate(new Date()))).rateTenThousandths)
  if (problem) return { kind: "invalid", fields: { vatCents: problem } }

  try {
    const asset = await prisma.$transaction(async (tx) => {
      const row = await tx.financedAsset.create({
        data: { ...data, tenantId, ...originationColumns(by) },
      })
      await logAuditStrict({
        tenantId,
        userId: audit.userId,
        userEmail: audit.userEmail,
        action: AuditAction.ASSET_CREATED,
        entity: "FinancedAsset",
        entityId: row.id,
        newValue: { ...data, ...(audit.actor ? { actor: audit.actor } : {}) },
      }, tx)
      return row
    })
    return { kind: "created", asset }
  } catch (error) {
    const duplicate = duplicateAssetMessage(error)
    if (!duplicate) throw error
    await auditRefusal({
      action: AuditAction.ASSET_DUPLICATE_REFUSED,
      entity: "FinancedAsset",
      entityId: data.serialNumber,
      tenantId,
      userId: audit.userId,
      userEmail: audit.userEmail,
      reason: "duplicate_unreleased_asset",
      status: 409,
      detail: { serialNumber: data.serialNumber, vin: data.vin, ...(audit.actor ? { actor: audit.actor } : {}) },
    })
    return { kind: "duplicate", message: duplicate }
  }
}
