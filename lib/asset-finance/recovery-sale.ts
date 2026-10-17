import { requireNcaSaleWindow } from "./surrender-lifecycle"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { prisma } from "@/lib/prisma"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { purchaseMaxAgeDays } from "./lease-term-end"
import type { RecoveryActor } from "./recovery-create"
import { RecoveryRefusal, refusable, type NotFound, type NotReady } from "./recovery-result"
import { screenBuyer } from "./recovery-screening"
import { actorIsBuyer, loadScreeningCandidates } from "./recovery-screening-store"
import type { SaleInput } from "./recovery-sale-input"
import type { SigningTx } from "./signing-prepare"

// Remarketing sale of a recovered asset: proposed on a LISTED recovery, screened
// for related parties, approved by a second person where the price is under the
// highest independent valuation or the buyer matched a screened list, then
// completed (./recovery-sale-complete.ts). The database repeats the valuation,
// below-valuation, related-party and second-approver rules (guardRemarketingSale).
// The lender's policy on sales below valuation and to related parties is signed off (see DESIGN.md sign-off record 2026-10-17).

export type SaleProposed = { kind: "done"; id: string; belowValuation: boolean; relatedPartyMatch: boolean; selfValued: boolean; approvalRequired: boolean }
export type SaleDone = { kind: "done"; id: string }

/** A sale needs a second approver when it is under the valuation, the buyer matched a screened list, or the proposer recorded the valuation it rests on. */
export const approvalRequired = (sale: { belowValuation: boolean; relatedPartyMatch: boolean; selfValued: boolean }) => sale.belowValuation || sale.relatedPartyMatch || sale.selfValued

/** Screening kind recorded when only the database matched the buyer (the borrower's or a related client's ID). */
export const DB_IDENTIFIER_KIND = "BORROWER_IDENTIFIER_DB"

/** The database's own sentence (guardRemarketingSale) for a sale that became self-valued after it was recorded. */
export const SELF_VALUED_RERECORD = "A sale on a valuation its proposer recorded needs the sale re-recorded as self-valued"

export const SELF_DEALING = "A staff member cannot propose, approve or complete the sale of an asset to themselves"

const auditActor = (actor: RecoveryActor) => ({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined })

/**
 * The highest current independent valuation, and whether the proposer recorded
 * it or the one the sale relies on (SELF_VALUED: nobody sells on a value they
 * set themselves without a second approver). "Independent" is the database's
 * rule: any source but INTERNAL, valued within leasePurchaseValuationMaxAgeDays.
 * (A lease purchase counts only assessors and dealers; a forced-sale
 * auctioneer valuation still binds a repossession sale.) A tie for highest
 * counts as the proposer's if any of the tied valuations is.
 * The lender's valuation-independence policy is signed off (see DESIGN.md sign-off record 2026-10-17).
 */
export async function valuationFacts(tx: SigningTx, tenantId: string, assetId: string, valuationId: string, today: string, proposerId: string) {
  const maxAge = await purchaseMaxAgeDays(tx, tenantId)
  const earliest = dbDate(fromDayNumber(toDayNumber(today) - maxAge))
  const valuation = await tx.assetValuation.findFirst({ where: { id: valuationId, tenantId, assetId }, select: { source: true, valuedOn: true, createdById: true } })
  if (!valuation) throw new RecoveryRefusal("The valuation is not of this asset")
  if (valuation.source === "INTERNAL") throw new RecoveryRefusal("A sale rests on an independent (not internal) valuation")
  if (valuation.valuedOn < earliest) throw new RecoveryRefusal(`The valuation must be dated within ${maxAge} days`)
  const current = { tenantId, assetId, source: { not: "INTERNAL" as const }, valuedOn: { gte: earliest } }
  const highestCents = (await tx.assetValuation.aggregate({ where: current, _max: { amountCents: true } }))._max.amountCents ?? 0
  const highest = await tx.assetValuation.findMany({ where: { ...current, amountCents: highestCents }, select: { createdById: true } })
  return { highestCents, selfValued: valuation.createdById === proposerId || highest.some((v) => v.createdById === proposerId) }
}

export async function proposeSale(actor: RecoveryActor, recoveryId: string, input: SaleInput): Promise<NotFound | NotReady | SaleProposed> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | SaleProposed> => {
    const recovery = await tx.recovery.findFirst({ where: { id: recoveryId, tenantId: actor.tenantId }, select: { id: true, status: true, assetId: true, loanId: true } })
    if (!recovery) return { kind: "not_found" }
    if (recovery.status !== "LISTED") throw new RecoveryRefusal("A sale is proposed on a listed recovery")
    await requireNcaSaleWindow(tx, actor.tenantId, recoveryId, "recovery")
    if (await actorIsBuyer(tx, actor.tenantId, actor.userId, { name: input.buyerName, identifier: input.buyerIdentifier })) throw new RecoveryRefusal(SELF_DEALING)
    const now = new Date()
    const today = sastCalendarDate(now)
    const { highestCents: highest, selfValued } = await valuationFacts(tx, actor.tenantId, recovery.assetId, input.valuationId, today, actor.userId)
    const belowValuation = input.priceInclVatCents < highest
    if (belowValuation && (input.belowValuationReason?.length ?? 0) < 10) {
      throw new RecoveryRefusal("A price under the highest independent valuation needs a reason of at least 10 characters")
    }
    const screening = screenBuyer(
      { name: input.buyerName, identifier: input.buyerIdentifier },
      await loadScreeningCandidates(tx, actor.tenantId, recovery.loanId, Number(today.slice(0, 4))),
    )
    const row = {
      tenantId: actor.tenantId, recoveryId: recovery.id, channel: input.channel, buyerType: input.buyerType,
      buyerName: input.buyerName, buyerIdentifier: input.buyerIdentifier, buyerAddress: input.buyerAddress, buyerVatNumber: input.buyerVatNumber,
      priceInclVatCents: input.priceInclVatCents, valuationId: input.valuationId, highestValuationCents: highest, belowValuation,
      belowValuationReason: belowValuation ? input.belowValuationReason : null, createdById: actor.userId, selfValued,
    }
    let matches: Array<{ kind: string; on: string }> = screening.matches
    // The database forces relatedPartyMatch for a buyer carrying the borrower's or a related client's ID, whatever the screening
    // said. A pending sale's screeningResult cannot be amended, so when the two disagree the insert is redone with the database's
    // reason in it (kind only), and the stored result agrees with the flag.
    await tx.$executeRaw`SAVEPOINT remarketing_sale_insert`
    let sale = await tx.remarketingSale.create({ data: { ...row, relatedPartyMatch: screening.match, screeningResult: { match: screening.match, matches, selfValued } } })
    if (sale.relatedPartyMatch && !screening.match) {
      await tx.$executeRaw`ROLLBACK TO SAVEPOINT remarketing_sale_insert`
      matches = [...screening.matches, { kind: DB_IDENTIFIER_KIND, on: "IDENTIFIER" }]
      sale = await tx.remarketingSale.create({ data: { ...row, relatedPartyMatch: true, screeningResult: { match: true, matches, selfValued } } })
    }
    await tx.$executeRaw`RELEASE SAVEPOINT remarketing_sale_insert`
    const flagged = sale.relatedPartyMatch
    await logAuditStrict({
      ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_SALE_PROPOSED, entity: "RemarketingSale", entityId: sale.id,
      newValue: {
        recoveryId: recovery.id, channel: input.channel, buyerType: input.buyerType, priceInclVatCents: input.priceInclVatCents,
        valuationId: input.valuationId, highestValuationCents: highest, belowValuation, relatedPartyMatch: flagged, selfValued,
      },
    }, tx)
    if (flagged) {
      await logAuditStrict({
        ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_RELATED_PARTY_FLAGGED, entity: "RemarketingSale", entityId: sale.id,
        newValue: { recoveryId: recovery.id, matches },
      }, tx)
    }
    return { kind: "done", id: sale.id, belowValuation, relatedPartyMatch: flagged, selfValued, approvalRequired: approvalRequired({ belowValuation, relatedPartyMatch: flagged, selfValued }) }
  }))
}

async function pendingSale(tx: SigningTx, actor: RecoveryActor, recoveryId: string, saleId: string) {
  const sale = await tx.remarketingSale.findFirst({ where: { id: saleId, recoveryId, tenantId: actor.tenantId } })
  if (!sale) return null
  if (sale.status !== "PENDING_APPROVAL") throw new RecoveryRefusal(`The sale is already ${sale.status.toLowerCase()}`)
  return sale
}

/** A second person (not the proposer) approves a sale that needs it. The database repeats this at completion. */
export async function approveSale(actor: RecoveryActor, recoveryId: string, saleId: string): Promise<NotFound | NotReady | SaleDone> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | SaleDone> => {
    const sale = await pendingSale(tx, actor, recoveryId, saleId)
    if (!sale) return { kind: "not_found" }
    const recovery = await tx.recovery.findFirst({ where: { id: recoveryId, tenantId: actor.tenantId }, select: { assetId: true } })
    if (!recovery) return { kind: "not_found" }
    const { selfValued } = await valuationFacts(tx, actor.tenantId, recovery.assetId, sale.valuationId, sastCalendarDate(new Date()), sale.createdById)
    if (selfValued && !sale.selfValued) throw new RecoveryRefusal(SELF_VALUED_RERECORD)
    if (!approvalRequired(sale)) throw new RecoveryRefusal("This sale needs no approval: it is at or above the valuation, the buyer matched no screened list and the proposer did not set the valuation")
    if (await actorIsBuyer(tx, actor.tenantId, actor.userId, { name: sale.buyerName, identifier: sale.buyerIdentifier })) throw new RecoveryRefusal(SELF_DEALING)
    if (sale.createdById === actor.userId) throw new RecoveryRefusal("A sale is approved by someone other than the person who proposed it")
    if (sale.approvedById) throw new RecoveryRefusal("The sale is already approved")
    await tx.remarketingSale.update({ where: { id: sale.id, tenantId: actor.tenantId }, data: { approvedById: actor.userId, approvedAt: new Date() } })
    await logAuditStrict({
      ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_SALE_APPROVED, entity: "RemarketingSale", entityId: sale.id,
      newValue: { recoveryId: sale.recoveryId, belowValuation: sale.belowValuation, relatedPartyMatch: sale.relatedPartyMatch, selfValued, proposedById: sale.createdById },
    }, tx)
    return { kind: "done", id: sale.id }
  }))
}

export async function cancelSale(actor: RecoveryActor, recoveryId: string, saleId: string): Promise<NotFound | NotReady | SaleDone> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | SaleDone> => {
    const sale = await pendingSale(tx, actor, recoveryId, saleId)
    if (!sale) return { kind: "not_found" }
    await tx.remarketingSale.update({ where: { id: sale.id, tenantId: actor.tenantId }, data: { status: "CANCELLED" } })
    await logAuditStrict({
      ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_SALE_CANCELLED, entity: "RemarketingSale", entityId: sale.id,
      newValue: { recoveryId: sale.recoveryId },
    }, tx)
    return { kind: "done", id: sale.id }
  }))
}
