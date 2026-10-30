/**
 * Makes LoanProduct equal the version of each product that is in effect, so every reader of LoanProduct (the marketing
 * calculators, the portal, the quote) sees it. A version is applied once (appliedAt); of several that came due together
 * only the latest is written and the others are stamped. Run by the nightly job (app/api/cron/product-version-activate) and
 * by an approval whose version takes effect the same day. Approval prices on the version in effect (resolve.ts), not on
 * LoanProduct, so a missed night changes nothing for an application.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { dbDate } from "@/lib/asset-finance/dates"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import type { Tx } from "@/lib/maker-checker/types"
import { versionNcaIssues } from "./nca"
import { versionFromRow } from "./resolve"

export interface ActivatedVersion {
  productId: string
  versionId: string
  version: number
  skipped: number[]
}

/** A version that came due but is not one an NCA lender may use today (the cap moved, or it was approved elsewhere): left unapplied, tried again each night. */
export interface BlockedVersion {
  productId: string
  versionId: string
  version: number
  issues: string[]
}

export async function activateDueVersions(tx: Tx, tenantId: string, today: string, actor: { id: string; email: string } | null, now = new Date()): Promise<{ activated: ActivatedVersion[]; blocked: BlockedVersion[] }> {
  const due = await tx.productVersion.findMany({
    where: { tenantId, appliedAt: null, effectiveFrom: { lte: dbDate(today) } },
    orderBy: [{ productId: "asc" }, { effectiveFrom: "asc" }],
  })
  const byProduct = new Map<string, typeof due>()
  for (const row of due) byProduct.set(row.productId, [...(byProduct.get(row.productId) ?? []), row])

  const activated: ActivatedVersion[] = []
  const blocked: BlockedVersion[] = []
  for (const [productId, versions] of byProduct) {
    const target = versions[versions.length - 1]!
    const before = await tx.loanProduct.findFirst({ where: { id: productId, tenantId } })
    if (!before) continue
    // The cap is read from the lender's repo rate as it stands tonight: a version approved under an earlier rate, or a
    // structure approved under another jurisdiction, is not written through to the product the portal and quotes advertise.
    if (isNcaJurisdiction()) {
      const issues = await versionNcaIssues(tenantId, { code: before.code, productType: before.productType }, versionFromRow(target).config)
      if (issues.length > 0) {
        blocked.push({ productId, versionId: target.id, version: target.version, issues })
        continue
      }
    }
    // Claim the versions first: a second run (the cron racing an approval) finds them taken and writes and audits nothing.
    const claimed = await tx.productVersion.updateMany({ where: { tenantId, id: { in: versions.map((v) => v.id) }, appliedAt: null }, data: { appliedAt: now } })
    if (claimed.count !== versions.length) continue
    const data = {
      minAmount: target.minAmount, maxAmount: target.maxAmount, minTermDays: target.minTermDays, maxTermDays: target.maxTermDays,
      interestRatePm: target.interestRatePm, interestModel: target.interestModel, initiationFeeModel: target.initiationFeeModel,
      initiationFeePct: target.initiationFeePct, initiationFeeMax: target.initiationFeeMax, monthlyServiceFee: target.monthlyServiceFee,
      // The customer channels show monthly instalments only: they stop offering a product while its version has a structure.
      repaymentStructured: target.structure !== null,
    }
    await tx.loanProduct.update({ where: { id: productId, tenantId }, data })
    const skipped = versions.slice(0, -1).map((v) => v.version)
    await logAuditStrict({
      tenantId, userId: actor?.id, userEmail: actor?.email ?? "system:product-version-activate", action: AuditAction.PRODUCT_VERSION_ACTIVATED,
      entity: "ProductVersion", entityId: target.id,
      oldValue: { minAmount: before.minAmount, maxAmount: before.maxAmount, minTermDays: before.minTermDays, maxTermDays: before.maxTermDays, interestRatePm: before.interestRatePm, interestModel: before.interestModel, initiationFeePct: before.initiationFeePct, monthlyServiceFee: before.monthlyServiceFee, repaymentStructured: before.repaymentStructured },
      newValue: { productId, version: target.version, effectiveFrom: today, skippedVersions: skipped, ...data },
    }, tx)
    activated.push({ productId, versionId: target.id, version: target.version, skipped })
  }
  return { activated, blocked }
}
