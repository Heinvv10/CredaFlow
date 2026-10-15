/**
 * Recovery demo data (slice 4a) on the seeded book, written through the lib
 * services the recovery routes use, so the database's triggers see the app's
 * own writes:
 *
 *  (1) The sole-proprietor TLB instalment sale (NCA), taken from its legal
 *      matter (./asset-finance-recovery-legal.ts) through the s131 recovery:
 *      independent valuation, valuation notice, listing, a storage cost (recorded
 *      by the officer, approved by the first admin), a sale BELOW the
 *      valuation (reason recorded, approved by the second admin), completed,
 *      proceeds applied, final notice, to SHORTFALL_OPEN. The legal steps are
 *      past-dated; the database dates the freeze and the final notice today.
 *  (2) The company's full-maintenance lease (NON_NCA): a voluntary recovery
 *      taken to LISTED with a valuation and an approved storage cost.
 *
 * Idempotent: each step runs only from the state before it. Every name and
 * number is synthetic.
 */
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { decideRecoveryCost, recordRecoveryCost } from "@/lib/asset-finance/recovery-costs"
import { createRecovery, listForSale, recordRecoveryValuation } from "@/lib/asset-finance/recovery-store"
import { issueRecoveryFinalNotice, issueRecoveryValuationNotice } from "@/lib/asset-finance/recovery-notices"
import { approveSale, proposeSale } from "@/lib/asset-finance/recovery-sale"
import { completeSale } from "@/lib/asset-finance/recovery-sale-complete"
import { applySaleProceeds } from "@/lib/asset-finance/recovery-proceeds"
import { settleOutcome } from "@/lib/asset-finance/recovery-freeze"
import type { RecoveryActor } from "@/lib/asset-finance/recovery-create"
import type { SeedActor } from "./asset-finance-documents"
import type { SeedStaff } from "./asset-finance-deal"
import { seedTlbLegalMatter } from "./asset-finance-recovery-legal"

export interface RecoverySeedContext {
  tenantId: string
  staff: SeedStaff
  tlb: { clientId: string; assetId: string }
  companyEntityId: string
}

const actorOf = (tenantId: string, a: SeedActor): RecoveryActor => ({ tenantId, userId: a.id, userEmail: a.email })

function expectDone(step: string, result: { kind: string }): void {
  if (result.kind !== "done") throw new Error(`Seed: recovery step "${step}" refused (${JSON.stringify(result)})`)
}

/** The valuation both recoveries rest on: an independent assessor's, dated today. */
const valuation = (amountCents: number) => ({ valuedOn: sastCalendarDate(new Date()), source: "ASSESSOR" as const, valuerName: "TEST Valuers (Pty) Ltd", amountCents })

async function statusOf(tenantId: string, id: string) {
  return (await prisma.recovery.findFirstOrThrow({ where: { id, tenantId }, select: { status: true, valuationId: true } })).status
}

/**
 * One storage cost, deducted from the proceeds: recorded by the officer, decided by
 * the first admin (two people), keyed by its invoice reference so a rerun adds nothing.
 */
async function ensureStorageCost(ctx: RecoverySeedContext, recoveryId: string, supplierInvoiceRef: string, netCents: number, today: string): Promise<void> {
  const { tenantId, staff } = ctx
  const existing = await prisma.recoveryCost.findFirst({ where: { tenantId, recoveryId, supplierInvoiceRef }, select: { id: true } })
  if (existing) return
  const recorded = await recordRecoveryCost(actorOf(tenantId, staff.officer), recoveryId, {
    type: "STORAGE", netCents, vatCents: 0, supplierInvoiceRef, incurredOn: today, treatment: "DEDUCT_FROM_PROCEEDS", note: "Synthetic yard storage",
  })
  expectDone("storage cost", recorded)
  expectDone("storage cost decision", await decideRecoveryCost(actorOf(tenantId, staff.adminOne), recoveryId, (recorded as { id: string }).id, "APPROVED"))
}

async function seedTlbRecovery(ctx: RecoverySeedContext, today: string): Promise<void> {
  const { tenantId, staff } = ctx
  const officer = actorOf(tenantId, staff.officer)
  const deal = await prisma.assetFinanceDeal.findFirstOrThrow({ where: { tenantId, clientId: ctx.tlb.clientId, assetId: ctx.tlb.assetId }, select: { loanId: true } })
  if (!deal.loanId) throw new Error("Seed: the TLB deal has no loan to recover")
  const { recoveryId } = await seedTlbLegalMatter(tenantId, staff.officer, deal.loanId, today)

  if (await statusOf(tenantId, recoveryId) === "RECOVERED") expectDone("valuation", await recordRecoveryValuation(officer, recoveryId, valuation(45_000_000)))
  if (await statusOf(tenantId, recoveryId) === "VALUED") expectDone("valuation notice", await issueRecoveryValuationNotice(officer, recoveryId))
  if (await statusOf(tenantId, recoveryId) === "VALUATION_NOTICE_ISSUED") expectDone("listing", await listForSale(officer, recoveryId))

  if (await statusOf(tenantId, recoveryId) === "LISTED") {
    const valuationId = (await prisma.recovery.findFirstOrThrow({ where: { id: recoveryId, tenantId }, select: { valuationId: true } })).valuationId
    if (!valuationId) throw new Error("Seed: the listed recovery has no valuation")
    await ensureStorageCost(ctx, recoveryId, "TEST-STORAGE-TLB-001", 650_000, today)
    let sale = await prisma.remarketingSale.findFirst({ where: { tenantId, recoveryId, status: "PENDING_APPROVAL" } })
    if (!sale) {
      // R400 000 against a R450 000 valuation: under it, so the reason is recorded and a second admin approves.
      const proposed = await proposeSale(officer, recoveryId, {
        channel: "AUCTION", buyerType: "ENTITY", buyerName: "TEST Plant Traders (Pty) Ltd", buyerIdentifier: "2098/700001/07", buyerAddress: "9 Synthetic Industrial Road, Johannesburg, 2000",
        buyerVatNumber: null, priceInclVatCents: 40_000_000, valuationId, belowValuationReason: "Highest bid at the synthetic auction; hydraulic wear found at inspection",
      })
      expectDone("sale proposal", proposed)
      sale = await prisma.remarketingSale.findFirstOrThrow({ where: { id: (proposed as { id: string }).id, tenantId } })
    }
    if (sale.belowValuation && !sale.approvedById) expectDone("sale approval", await approveSale(actorOf(tenantId, staff.adminOne), recoveryId, sale.id))
    expectDone("sale completion", await completeSale(officer, recoveryId, sale.id, { completedOn: today }))
  }
  if (await statusOf(tenantId, recoveryId) === "SOLD") expectDone("proceeds", await applySaleProceeds(officer, recoveryId))
  if (await statusOf(tenantId, recoveryId) === "PROCEEDS_APPLIED") expectDone("final notice", await issueRecoveryFinalNotice(officer, recoveryId))
  if (await statusOf(tenantId, recoveryId) === "FINAL_NOTICE_ISSUED") expectDone("outcome", await settleOutcome(officer, recoveryId))
}

async function seedFmlRecovery(ctx: RecoverySeedContext, today: string): Promise<void> {
  const { tenantId, staff } = ctx
  const officer = actorOf(tenantId, staff.officer)
  const loan = await prisma.loan.findFirstOrThrow({ where: { tenantId, entityId: ctx.companyEntityId, contractType: "FULL_MAINTENANCE_LEASE" }, select: { id: true } })
  let recovery = await prisma.recovery.findFirst({ where: { tenantId, loanId: loan.id }, select: { id: true } })
  if (!recovery) {
    const created = await createRecovery(officer, loan.id, {
      route: "NON_NCA_VOLUNTARY", recoveredOn: today, location: "TEST Lessor Yard, Johannesburg", condition: "Handed back voluntarily; used, good condition.",
    })
    expectDone("voluntary recovery", created)
    recovery = { id: (created as { id: string }).id }
  }
  if (await statusOf(tenantId, recovery.id) === "RECOVERED") expectDone("valuation", await recordRecoveryValuation(officer, recovery.id, valuation(32_000_000)))
  if (await statusOf(tenantId, recovery.id) === "VALUED") expectDone("listing", await listForSale(officer, recovery.id))
  if (await statusOf(tenantId, recovery.id) === "LISTED") await ensureStorageCost(ctx, recovery.id, "TEST-STORAGE-FML-001", 420_000, today)
}

export async function seedRecoveries(ctx: RecoverySeedContext): Promise<void> {
  const today = sastCalendarDate(new Date())
  await seedTlbRecovery(ctx, today)
  await seedFmlRecovery(ctx, today)
}
