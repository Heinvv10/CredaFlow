/**
 * Helpers for the recovery gap suites (RUN_ASSET_FINANCE_RECOVERY_IT): an
 * acceptance deal's recovery taken to LISTED for any of its four routes (the
 * NON_NCA court-order route stands on a judgment, which listedDealRecovery in
 * recovery-sale.integration-fixture.ts does not give it), and a debtor that is
 * a VAT vendor on any route (an entity with a VAT number, also behind an NCA
 * loan). Every value is synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, RecoveryCostType } from "@prisma/client"
import type { AcceptanceRecoveryDeal } from "./__fixtures__/acceptance-recovery-deals"
import type { DealFixture } from "./deal.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { advance, recordDecidedCost } from "./recovery-path.integration-fixture"
import { disburseApplication } from "./recovery-sale.integration-fixture"
import { courtMatter, newLoan, newRecovery, newSurrender, type RecoveryLoan } from "./recovery.integration-fixture"

export interface GapDealRecovery {
  loan: RecoveryLoan
  id: string
  valuationId: string
  surrenderRequestId: string | null
}

export const VENDOR_VAT_NUMBER = "4000000099"

/** The loan's debtor as a VAT vendor (or not): an entity with a VAT number, which on an NCA loan replaces the consumer (a juristic borrower; a loan has one or the other). */
async function setDebtorVat(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan, vendor: boolean): Promise<void> {
  if (loan.entityId) {
    await testSetup(db, [`UPDATE "BusinessEntity" SET "vatNumber" = $1 WHERE "id" = $2`, vendor ? VENDOR_VAT_NUMBER : null, loan.entityId])
    return
  }
  if (!vendor) return
  const token = randomUUID().replaceAll("-", "").slice(0, 8)
  const entity = await db.businessEntity.create({
    data: { tenantId: fx.tenantId, type: "COMPANY", legalName: `TEST Vendor ${token} (Pty) Ltd`, registrationNumber: `2099/${token.slice(0, 6)}/07`, vatNumber: VENDOR_VAT_NUMBER },
  })
  await testSetup(db, [`UPDATE "Loan" SET "entityId" = $1, "clientId" = NULL WHERE "id" = $2`, entity.id, loan.loanId])
}

/**
 * The deal's recovery at LISTED: a fresh loan whose settlement is exactly the
 * deal's (no schedule, no interest, charges off) and whose unpaid cash price and
 * asset price are the deal's, valued under the sale price so no approval is
 * needed, with the deal's costs recorded (already approved) before the sale.
 */
export async function listedGapDeal(db: PrismaClient, fx: DealFixture, deal: AcceptanceRecoveryDeal): Promise<GapDealRecovery> {
  const regime = deal.route.startsWith("NCA") ? "NCA" : "NON_NCA"
  const loan = await newLoan(db, fx, regime, deal.contractType)
  const surrenderId = deal.route === "NCA_S127_SURRENDER" ? await newSurrender(db, fx, loan) : undefined
  const extra = deal.route === "NCA_S127_SURRENDER" ? { surrenderRequestId: surrenderId }
    : deal.route === "NON_NCA_VOLUNTARY" ? {} : { legalMatterId: await courtMatter(db, fx, loan) }
  const id = await newRecovery(db, fx, loan, deal.route, extra)
  await advance(db, fx, loan, id, "LISTED", { valuationCents: Math.floor(deal.grossProceedsCents / 2), surrenderId })
  const exclCash = Math.round(deal.cashPriceInclVatCents * 10_000 / 11_500) || 100_000_000
  await testSetup(db,
    [`UPDATE "Loan" SET "principal" = $1, "totalInterest" = 0, "totalRepayable" = $1, "outstandingPrincipal" = $2 WHERE "id" = $3`,
      deal.settlementDueCents, deal.unpaidCashPriceCents, loan.loanId],
    [`UPDATE "FinancedAsset" SET "cashPriceExclVatCents" = $1, "vatCents" = $2 WHERE "id" = $3`, exclCash, (deal.cashPriceInclVatCents || 115_000_000) - exclCash, loan.assetId],
  )
  await setDebtorVat(db, fx, loan, deal.debtorVatVendor)
  await disburseApplication(db, fx, loan)
  const rec = await db.recovery.findUniqueOrThrow({ where: { id }, select: { valuationId: true, legalMatterId: true, surrenderRequestId: true } })
  const judgment = rec.legalMatterId ? await db.legalMatterStep.findFirst({ where: { matterId: rec.legalMatterId, kind: "JUDGMENT" }, select: { id: true } }) : null
  for (const cost of deal.costs) {
    await recordDecidedCost(db, fx, id, {
      type: cost.type as RecoveryCostType, treatment: cost.treatment, grossCents: cost.grossCents, legalStepId: cost.type === "LEGAL_TAXED" ? judgment?.id : undefined,
    }, "APPROVED", { netCents: cost.netCents, vatCents: cost.vatCents })
  }
  return { loan, id, valuationId: rec.valuationId as string, surrenderRequestId: rec.surrenderRequestId }
}
