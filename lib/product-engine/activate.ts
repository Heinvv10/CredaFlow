/**
 * Makes LoanProduct equal the version of each product that is in effect, so every reader of LoanProduct (the marketing
 * calculators, the portal, the quote) sees it. A version is applied once (appliedAt); of several that came due together
 * only the latest is written and the others are stamped. Run by the nightly job (app/api/cron/product-version-activate) and
 * by an approval whose version takes effect the same day. Approval prices on the version in effect (resolve.ts), not on
 * LoanProduct, so a missed night changes nothing for an application.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate } from "@/lib/asset-finance/dates"
import type { Tx } from "@/lib/maker-checker/types"

export interface ActivatedVersion {
  productId: string
  versionId: string
  version: number
  skipped: number[]
}

export async function activateDueVersions(tx: Tx, tenantId: string, today: string, actor: { id: string; email: string } | null, now = new Date()): Promise<ActivatedVersion[]> {
  const due = await tx.productVersion.findMany({
    where: { tenantId, appliedAt: null, effectiveFrom: { lte: dbDate(today) } },
    orderBy: [{ productId: "asc" }, { effectiveFrom: "asc" }],
  })
  const byProduct = new Map<string, typeof due>()
  for (const row of due) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row])

  const activated: ActivatedVersion[] = []
  for (const [productId, versions] of byProduct) {
    const target = versions[versions.length - 1]!
    const before = await tx.loanProduct.findFirst({ where: { id: productId, tenantId } })
    if (!before) continue
    const data = {
      minAmount: target.minAmount, maxAmount: target.maxAmount, minTermDays: target.minTermDays, maxTermDays: target.maxTermDays,
      interestRatePm: target.interestRatePm, interestModel: target.interestModel, initiationFeeModel: target.initiationFeeModel,
      initiationFeePct: target.initiationFeePct, initiationFeeMax: target.initiationFeeMax, monthlyServiceFee: target.monthlyServiceFee,
    }
    await tx.loanProduct.update({ where: { id: productId, tenantId }, data })
    await tx.productVersion.updateMany({ where: { tenantId, id: { in: versions.map((v) => v.id) }, appliedAt: null }, data: { appliedAt: now } })
    const skipped = versions.slice(0, -1).map((v) => v.version)
    await logAuditStrict({
      tenantId, userId: actor?.id, userEmail: actor?.email ?? "system:product-version-activate", action: AuditAction.PRODUCT_VERSION_ACTIVATED,
      entity: "ProductVersion", entityId: target.id,
      oldValue: { minAmount: before.minAmount, maxAmount: before.maxAmount, minTermDays: before.minTermDays, maxTermDays: before.maxTermDays, interestRatePm: before.interestRatePm, interestModel: before.interestModel, initiationFeePct: before.initiationFeePct, monthlyServiceFee: before.monthlyServiceFee },
      newValue: { productId, version: target.version, effectiveFrom: today, skippedVersions: skipped, ...data },
    }, tx)
    activated.push({ productId, versionId: target.id, version: target.version, skipped })
  }
  return activated
}
