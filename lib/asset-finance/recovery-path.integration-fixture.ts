/**
 * Walks a recovery through its statuses with the real guards on, so a suite
 * can attack the rule it cares about from a recovery committed at any status:
 * valuation (a fresh assessor valuation), listing, a completed sale (one tax
 * invoice, no approval needed: at the valuation, to a stranger), the proceeds
 * (a real payment row for the lesser of the net proceeds and the settlement),
 * the final notice, then the shortfall, surplus or closure. An s127 recovery
 * also moves its surrender with triggers off (the surrender's own rules have
 * their suites). Every value is synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import type { ContractType, PrismaClient, RecoveryCostTreatment, RecoveryCostType, RecoveryStatus } from "@prisma/client"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { dbDate } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import type { DealFixture } from "./deal.integration-fixture"
import { courtMatter, newLoan, newRecovery, newSurrender, newValuation, saleInvoice, today, type RecoveryLoan } from "./recovery.integration-fixture"

const NCA_ORDER: RecoveryStatus[] = ["RECOVERED", "VALUED", "VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED", "FINAL_NOTICE_ISSUED"]
const NON_NCA_ORDER: RecoveryStatus[] = ["RECOVERED", "VALUED", "LISTED", "SOLD", "PROCEEDS_APPLIED"]
const SHA = "a".repeat(64)

/** The idempotency key the proceeds receipt of a recovery carries. */
export const proceedsKey = (recoveryId: string) => `asset-recovery:${recoveryId}:proceeds`

export interface PathOptions {
  priceCents?: number
  valuationCents?: number
  settlementCents?: number
  /** Costs recorded (already approved) before the sale. */
  costs?: { type: RecoveryCostType; treatment: RecoveryCostTreatment; grossCents: number; legalStepId?: string }[]
  /** A surrender row of an s127 recovery. */
  surrenderId?: string
  /** The charged costs the ledger could not carry, written with the proceeds: 0 unless said; null leaves it unset. */
  unrecoverableCents?: number | null
}

/** A cost as it is recorded: PENDING, undecided (the second person decides it later). */
export const costData = (fx: DealFixture, recoveryId: string, c: NonNullable<PathOptions["costs"]>[number]) => ({
  tenantId: fx.tenantId, recoveryId, type: c.type, netCents: c.grossCents, vatCents: 0, grossCents: c.grossCents, supplierInvoiceRef: `INV-${randomUUID().slice(0, 8)}`,
  incurredOn: dbDate(today()), treatment: c.treatment, legalStepId: c.legalStepId ?? null, recordedById: fx.officer,
})

/** A cost recorded and then decided by a second person (APPROVED unless said otherwise). */
export async function recordDecidedCost(
  db: Pick<PrismaClient, "recoveryCost">, fx: DealFixture, recoveryId: string, c: NonNullable<PathOptions["costs"]>[number], decision: "APPROVED" | "REJECTED" = "APPROVED",
  extra: Record<string, unknown> = {},
) {
  const cost = await db.recoveryCost.create({ data: { ...costData(fx, recoveryId, c), ...extra } })
  return db.recoveryCost.update({ where: { id: cost.id }, data: { status: decision, approvedById: fx.adminA, approvedAt: new Date() } })
}

/** The highest current independent valuation of an asset (what the sale trigger recomputes). */
export async function highestValuation(db: PrismaClient, tenantId: string, assetId: string): Promise<number> {
  const rows = await db.assetValuation.findMany({ where: { tenantId, assetId, source: { not: "INTERNAL" } }, select: { amountCents: true } })
  return Math.max(0, ...rows.map((r) => r.amountCents))
}

/** The data of a sale to a stranger at the valuation (no approval needed); `extra` overrides. */
export async function saleData(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan, recoveryId: string, extra: Record<string, unknown> = {}) {
  const valuationId = (await db.assetValuation.findFirstOrThrow({ where: { tenantId: fx.tenantId, assetId: loan.assetId, source: { not: "INTERNAL" } }, orderBy: { amountCents: "desc" } })).id
  const highest = await highestValuation(db, fx.tenantId, loan.assetId)
  const price = 120_000_000
  return {
    tenantId: fx.tenantId, recoveryId, channel: "AUCTION" as const, buyerType: "PERSON" as const, buyerName: "TEST Buyer", buyerIdentifier: "7001015800084",
    buyerAddress: "2 Buyer Street", priceInclVatCents: price, valuationId, highestValuationCents: highest, belowValuation: price < highest, relatedPartyMatch: false,
    screeningResult: { lists: [], matches: 0 }, createdById: fx.officer, ...extra,
  }
}

/** A fresh loan and a recovery of it (NCA: s131 on a court matter, or s127 on a surrender) taken to `to`. */
export async function ladderRecovery(
  db: PrismaClient, fx: DealFixture, nca: boolean, to: RecoveryStatus, o: PathOptions = {}, s127 = false, contractType: ContractType = "INSTALMENT_SALE",
): Promise<{ loan: RecoveryLoan; id: string; surrenderId?: string }> {
  const loan = await newLoan(db, fx, nca ? "NCA" : "NON_NCA", contractType)
  const surrenderId = s127 ? await newSurrender(db, fx, loan) : undefined
  const route = !nca ? "NON_NCA_VOLUNTARY" : s127 ? "NCA_S127_SURRENDER" : "NCA_S131_ATTACHMENT"
  const extra = !nca ? {} : s127 ? { surrenderRequestId: surrenderId } : { legalMatterId: await courtMatter(db, fx, loan) }
  const id = await newRecovery(db, fx, loan, route, extra)
  await advance(db, fx, loan, id, to, { ...o, surrenderId })
  return { loan, id, surrenderId }
}

export async function advance(db: PrismaClient, fx: DealFixture, loan: RecoveryLoan, recoveryId: string, to: RecoveryStatus, o: PathOptions = {}): Promise<void> {
  const rec = await db.recovery.findUniqueOrThrow({ where: { id: recoveryId } })
  const order = loan.regime === "NCA" ? NCA_ORDER : NON_NCA_ORDER
  const s127 = rec.route === "NCA_S127_SURRENDER"
  const set = (data: Record<string, unknown>) => db.recovery.update({ where: { id: recoveryId }, data: data as never })
  const done: RecoveryStatus[] = ["SHORTFALL_OPEN", "SURPLUS_HELD", "CLOSED", "WITHDRAWN"]
  if (done.includes(to)) {
    // Shortfall, surplus (settlement below the net proceeds) or nothing owed (settlement = the price) follow the proceeds; a withdrawal is from any earlier status.
    if (to !== "WITHDRAWN") await advance(db, fx, loan, recoveryId, loan.regime === "NCA" ? "FINAL_NOTICE_ISSUED" : "PROCEEDS_APPLIED", o)
    // a surplus is held only once the receipt has settled the loan (applyManualReceipt completes it); here the loan is settled directly
    if (to === "SURPLUS_HELD") await testSetup(db, [`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, loan.loanId])
    await set({ status: to, ...(to === "WITHDRAWN" ? { withdrawnReason: "Debtor paid the arrears in full", closedAt: new Date() } : to === "CLOSED" ? { closedAt: new Date() } : {}) })
    return
  }
  const surrender = (status: string, extra = "") => testSetup(db, [`UPDATE "SurrenderRequest" SET "status" = $1::"SurrenderStatus"${extra} WHERE "id" = $2`, status, o.surrenderId])
  for (const next of order.slice(order.indexOf(rec.status) + 1, order.indexOf(to) + 1)) {
    if (next === "VALUED") {
      const valuationId = await newValuation(db, fx, loan.assetId, o.valuationCents)
      if (s127) await testSetup(db, [`UPDATE "SurrenderRequest" SET "valuationId" = $1 WHERE "id" = $2`, valuationId, o.surrenderId])
      await set({ status: next, valuationId })
    } else if (next === "VALUATION_NOTICE_ISSUED") {
      if (s127) await surrender("VALUATION_NOTICE_ISSUED", `, "valuationNoticePath" = '/nonexistent/vn.pdf', "valuationNoticeSha256" = '${SHA}'`)
      await set({ status: next, ...(s127 ? {} : { valuationNoticePath: "/nonexistent/vn.pdf", valuationNoticeSha256: SHA }) })
      await testSetup(db, [`UPDATE "Recovery" SET "valuationNoticeIssuedOn"=CURRENT_DATE-30,"valuationNoticeReceivedOn"=CURRENT_DATE-30,"valuationReceiptReference"='Synthetic delivery proof; fixture time advanced' WHERE "id"=$1`,recoveryId])
      if (s127) await testSetup(db, [`UPDATE "SurrenderRequest" SET "valuationNoticeIssuedOn"=CURRENT_DATE-30,"valuationNoticeReceivedOn"=CURRENT_DATE-30,"valuationReceiptReference"='Synthetic delivery proof; fixture time advanced' WHERE "id"=$1`,o.surrenderId])
    } else if (next === "LISTED") {
      await set({ status: next })
    } else if (next === "SOLD") {
      for (const c of o.costs ?? []) await recordDecidedCost(db, fx, recoveryId, c)
      const sale = await db.remarketingSale.create({ data: await saleData(db, fx, loan, recoveryId, o.priceCents ? { priceInclVatCents: o.priceCents, belowValuation: false } : {}) })
      await db.remarketingSale.update({ where: { id: sale.id }, data: { status: "COMPLETED", completedAt: new Date(), taxInvoiceId: await saleInvoice(db, fx, sale.priceInclVatCents) } })
      await set({ status: next })
    } else if (next === "PROCEEDS_APPLIED") {
      const costs = await db.recoveryCost.findMany({ where: { recoveryId, status: "APPROVED" } })
      const sum = (t: RecoveryCostTreatment) => costs.filter((c) => c.treatment === t).reduce((n, c) => n + c.grossCents, 0)
      const sale = await db.remarketingSale.findFirstOrThrow({ where: { recoveryId, status: "COMPLETED" } })
      const gross = sale.priceInclVatCents
      const deducted = sum("DEDUCT_FROM_PROCEEDS")
      const charged = sum("CHARGE_TO_ACCOUNT")
      const net = gross - deducted
      const settlement = o.settlementCents ?? 150_000_000
      const owed = settlement + charged
      const receipt = Math.min(net, settlement)
      const payment = receipt > 0 ? await db.payment.create({ data: { tenantId: fx.tenantId, loanId: loan.loanId, amount: receipt, capturedBy: fx.officer, reference: `SYNTH-${randomUUID().slice(0, 8)}`, idempotencyKey: proceedsKey(recoveryId) } }) : null
      const from = today()
      await set({
        status: next, settlementDueCents: settlement, grossProceedsCents: gross, deductedCostsCents: deducted, chargedCostsCents: charged, netProceedsCents: net,
        shortfallCents: Math.max(0, owed - net), surplusCents: Math.max(0, net - owed), proceedsPaymentId: payment?.id ?? null,
        unrecoverableCostsCents: o.unrecoverableCents === undefined ? 0 : o.unrecoverableCents,
        chargesFrozenFrom: dbDate(from), ...(loan.regime === "NON_NCA" ? { chargesFrozenUntil: dbDate(addDays(from, 10)) } : {}),
      })
    } else if (next === "FINAL_NOTICE_ISSUED") {
      if (!s127) {
        const row = await db.recovery.findUniqueOrThrow({ where: { id: recoveryId } })
        if ((row.surplusCents ?? 0) > 0) await db.ncaSurplusRemittance.create({ data: { tenantId: fx.tenantId, recoveryId, amountCents: row.surplusCents!, status: "HELD_NO_VERIFIED_ACCOUNT", exceptionReason: "Synthetic fixture: no verified bank account", issuedById: fx.officer } })
      }
      if (s127) await surrender("FINAL_NOTICE_ISSUED", `, "finalNoticePath" = '/nonexistent/fn.pdf', "finalNoticeSha256" = '${SHA}'`)
      await set({
        status: next, finalNoticeIssuedOn: dbDate(today()), chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(today(), 10)),
        ...(s127 ? {} : { finalNoticePath: "/nonexistent/fn.pdf", finalNoticeSha256: SHA }),
      })
    } else {
      await set({ status: next })
    }
  }
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
