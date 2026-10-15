/**
 * Helpers for the slice 4a sale / proceeds / freeze / refund suites
 * (RUN_ASSET_FINANCE_RECOVERY_IT): the real route handlers called as a staff
 * session, a loan booked so its settlement is exactly an acceptance deal's
 * (lib/asset-finance/__fixtures__/acceptance-recovery-deals.ts), and a recovery
 * of it taken to LISTED through the real guards. Every value is synthetic.
 * Not a test file.
 */
import type { PrismaClient, RecoveryCostType } from "@prisma/client"
import { NextRequest } from "next/server"
import { POST as saleRoute } from "@/app/api/asset-finance/recoveries/[id]/sales/route"
import { POST as approveSaleRoute } from "@/app/api/asset-finance/recoveries/[id]/sales/[saleId]/approve/route"
import { POST as completeSaleRoute } from "@/app/api/asset-finance/recoveries/[id]/sales/[saleId]/complete/route"
import { POST as cancelSaleRoute } from "@/app/api/asset-finance/recoveries/[id]/sales/[saleId]/cancel/route"
import { POST as proceedsRoute } from "@/app/api/asset-finance/recoveries/[id]/proceeds/route"
import { POST as outcomeRoute } from "@/app/api/asset-finance/recoveries/[id]/outcome/route"
import { POST as refundRoute } from "@/app/api/asset-finance/recoveries/[id]/refund/route"
import { POST as approveRefundRoute } from "@/app/api/asset-finance/recoveries/[id]/refund/approve/route"
import { POST as releaseRefundRoute } from "@/app/api/asset-finance/recoveries/[id]/refund/release/route"
import type { AcceptanceRecoveryDeal } from "./__fixtures__/acceptance-recovery-deals"
import { advance, costData, ladderRecovery } from "./recovery-path.integration-fixture"
import { courtMatter, newLoan, newRecovery, newSurrender, type RecoveryLoan } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import type { DealFixture } from "./deal.integration-fixture"

export function saleRoutes(host: string) {
  const json = (path: string, body: unknown = {}) => new NextRequest(`http://${host}${path}`, {
    method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const base = (id: string) => `/api/asset-finance/recoveries/${id}`
  return {
    propose: (id: string, body: unknown) => saleRoute(json(`${base(id)}/sales`, body), { params: Promise.resolve({ id }) }),
    approveSale: (id: string, saleId: string) => approveSaleRoute(json(`${base(id)}/sales/${saleId}/approve`), { params: Promise.resolve({ id, saleId }) }),
    completeSale: (id: string, saleId: string, body: unknown = {}) => completeSaleRoute(json(`${base(id)}/sales/${saleId}/complete`, body), { params: Promise.resolve({ id, saleId }) }),
    cancelSale: (id: string, saleId: string) => cancelSaleRoute(json(`${base(id)}/sales/${saleId}/cancel`), { params: Promise.resolve({ id, saleId }) }),
    proceeds: (id: string, body: unknown = {}) => proceedsRoute(json(`${base(id)}/proceeds`, body), { params: Promise.resolve({ id }) }),
    outcome: (id: string) => outcomeRoute(json(`${base(id)}/outcome`), { params: Promise.resolve({ id }) }),
    refund: (id: string, form: FormData) => refundRoute(
      new NextRequest(`http://${host}${base(id)}/refund`, { method: "POST", headers: { host }, body: form }), { params: Promise.resolve({ id }) }),
    approveRefund: (id: string) => approveRefundRoute(json(`${base(id)}/refund/approve`), { params: Promise.resolve({ id }) }),
    releaseRefund: (id: string) => releaseRefundRoute(json(`${base(id)}/refund/release`), { params: Promise.resolve({ id }) }),
  }
}

export const readJson = async (response: Response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> })

/** A bank-confirmation scan the upload checks accept (PDF magic bytes). */
export const bankConfirmation = () => new File([new Uint8Array(Buffer.from("%PDF-1.4 synthetic bank confirmation"))], "bank-confirmation.pdf", { type: "application/pdf" })

export function refundForm(over: Record<string, string> = {}): FormData {
  const form = new FormData()
  const fields = { accountHolder: "TEST Debtor", bankName: "TEST Bank", branchCode: "250655", accountNumber: "62000000001", docType: "BANK_STATEMENT", ...over }
  for (const [key, value] of Object.entries(fields)) form.set(key, value)
  form.set("file", bankConfirmation())
  return form
}

/** The body of a sale to a stranger at `priceInclVatCents`, on `valuationId`. */
export const saleBody = (valuationId: string, priceInclVatCents: number, over: Record<string, unknown> = {}) => ({
  channel: "AUCTION", buyerType: "PERSON", buyerName: "TEST Buyer", buyerIdentifier: "7001015800084", buyerAddress: "2 Buyer Street, Testville",
  priceInclVatCents, valuationId, ...over,
})

export interface DealRecovery {
  loan: RecoveryLoan
  id: string
  valuationId: string
  judgmentStepId: string | null
}

/**
 * The deal's recovery at LISTED: a fresh loan whose settlement is exactly
 * `settlementDueCents` (no schedule, no interest, charges off), whose financed
 * amount outstanding is the deal's unpaid cash price and whose asset has the
 * deal's VAT-inclusive cash price, valued under the sale price so no approval
 * is needed; its costs recorded (already approved) before the sale.
 */
export async function listedDealRecovery(db: PrismaClient, fx: DealFixture, deal: AcceptanceRecoveryDeal, regime: "NCA" | "NON_NCA"): Promise<DealRecovery> {
  const s127 = deal.route === "NCA_S127_SURRENDER"
  const loan = await newLoan(db, fx, regime, deal.contractType)
  const surrenderId = s127 ? await newSurrender(db, fx, loan) : undefined
  const extra = regime === "NON_NCA" ? {} : s127 ? { surrenderRequestId: surrenderId } : { legalMatterId: await courtMatter(db, fx, loan) }
  const id = await newRecovery(db, fx, loan, deal.route, extra)
  await advance(db, fx, loan, id, "LISTED", { valuationCents: Math.floor(deal.grossProceedsCents / 2), surrenderId })
  const exclCash = Math.round(deal.cashPriceInclVatCents * 10_000 / 11_500) || 100_000_000
  await testSetup(db,
    [`UPDATE "Loan" SET "principal" = $1, "totalInterest" = 0, "totalRepayable" = $1, "outstandingPrincipal" = $2 WHERE "id" = $3`,
      deal.settlementDueCents, deal.unpaidCashPriceCents, loan.loanId],
    [`UPDATE "FinancedAsset" SET "cashPriceExclVatCents" = $1, "vatCents" = $2 WHERE "id" = $3`, exclCash, (deal.cashPriceInclVatCents || 115_000_000) - exclCash, loan.assetId],
  )
  if (loan.entityId) await testSetup(db, [`UPDATE "BusinessEntity" SET "vatNumber" = $1 WHERE "id" = $2`, deal.debtorVatVendor ? "4000000099" : null, loan.entityId])
  await disburseApplication(db, fx, loan)
  const rec = await db.recovery.findUniqueOrThrow({ where: { id }, select: { valuationId: true, legalMatterId: true } })
  const judgment = rec.legalMatterId
    ? await db.legalMatterStep.findFirst({ where: { matterId: rec.legalMatterId, kind: "JUDGMENT" }, select: { id: true } })
    : null
  for (const cost of deal.costs) {
    await db.recoveryCost.create({ data: {
      ...costData(fx, id, { type: cost.type as RecoveryCostType, treatment: cost.treatment, grossCents: cost.grossCents, legalStepId: cost.type === "LEGAL_TAXED" ? judgment?.id : undefined }),
      netCents: cost.netCents, vatCents: cost.vatCents,
    } })
  }
  return { loan, id, valuationId: rec.valuationId as string, judgmentStepId: judgment?.id ?? null }
}

/**
 * A NON_NCA loan may take a receipt only once its application is DISBURSED, approved and
 * NON_NCA (a deferred commit rule); the fixture books loans without that. An NCA loan needs nothing.
 */
export async function disburseApplication(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan): Promise<void> {
  if (loan.regime !== "NON_NCA") return
  await testSetup(db, [
    `UPDATE "LoanApplication" SET "status" = 'DISBURSED'::"AppStatus", "approvedAt" = CURRENT_TIMESTAMP, "approvedById" = $2, "disbursedAt" = CURRENT_TIMESTAMP, "repaymentMethod" = 'EFT'::"LoanRepaymentMethod"
     WHERE "id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, loan.loanId, fx.adminA,
  ])
}

/** A fresh recovery at LISTED for a loan of default size, plain (no deal figures). */
export async function plainListed(db: PrismaClient, fx: DealFixture, regime: "NCA" | "NON_NCA", valuationCents = 100_000_000) {
  const { loan, id } = await ladderRecovery(db, fx, regime === "NCA", "LISTED", { valuationCents })
  await disburseApplication(db, fx, loan)
  const rec = await db.recovery.findUniqueOrThrow({ where: { id }, select: { valuationId: true } })
  return { loan, id, valuationId: rec.valuationId as string }
}

export { newLoan }
