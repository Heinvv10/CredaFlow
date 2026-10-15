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
// UNTESTED: legal | the lender's policy on sales below valuation and to related parties.

export type SaleProposed = { kind: "done"; id: string; belowValuation: boolean; relatedPartyMatch: boolean; approvalRequired: boolean }
export type SaleDone = { kind: "done"; id: string }

export const approvalRequired = (sale: { belowValuation: boolean; relatedPartyMatch: boolean }) => sale.belowValuation || sale.relatedPartyMatch

export const SELF_DEALING = "A staff member cannot propose, approve or complete the sale of an asset to themselves"

const auditActor = (actor: RecoveryActor) => ({ tenantId: actor.tenantId, userId: actor.userId, userEmail: actor.userEmail ?? undefined })

/**
 * The valuation the sale relies on and the highest current independent one.
 * "Independent" is the database's rule: any source but INTERNAL, valued within
 * leasePurchaseValuationMaxAgeDays. (A lease purchase counts only assessors and
 * dealers; a forced-sale auctioneer valuation still binds a repossession sale.)
 */
async function independentValuation(tx: SigningTx, tenantId: string, assetId: string, valuationId: string, today: string) {
  const maxAge = await purchaseMaxAgeDays(tx, tenantId)
  const earliest = dbDate(fromDayNumber(toDayNumber(today) - maxAge))
  const valuation = await tx.assetValuation.findFirst({ where: { id: valuationId, tenantId, assetId }, select: { source: true, valuedOn: true } })
  if (!valuation) throw new RecoveryRefusal("The valuation is not of this asset")
  if (valuation.source === "INTERNAL") throw new RecoveryRefusal("A sale rests on an independent (not internal) valuation")
  if (valuation.valuedOn < earliest) throw new RecoveryRefusal(`The valuation must be dated within ${maxAge} days`)
  const best = await tx.assetValuation.aggregate({
    where: { tenantId, assetId, source: { not: "INTERNAL" }, valuedOn: { gte: earliest } }, _max: { amountCents: true },
  })
  return best._max.amountCents ?? 0
}

export async function proposeSale(actor: RecoveryActor, recoveryId: string, input: SaleInput): Promise<NotFound | NotReady | SaleProposed> {
  return refusable(() => prisma.$transaction(async (tx): Promise<NotFound | SaleProposed> => {
    const recovery = await tx.recovery.findFirst({ where: { id: recoveryId, tenantId: actor.tenantId }, select: { id: true, status: true, assetId: true, loanId: true } })
    if (!recovery) return { kind: "not_found" }
    if (recovery.status !== "LISTED") throw new RecoveryRefusal("A sale is proposed on a listed recovery")
    if (await actorIsBuyer(tx, actor.tenantId, actor.userId, { name: input.buyerName, identifier: input.buyerIdentifier })) throw new RecoveryRefusal(SELF_DEALING)
    const now = new Date()
    const today = sastCalendarDate(now)
    const highest = await independentValuation(tx, actor.tenantId, recovery.assetId, input.valuationId, today)
    const belowValuation = input.priceInclVatCents < highest
    if (belowValuation && (input.belowValuationReason?.length ?? 0) < 10) {
      throw new RecoveryRefusal("A price under the highest independent valuation needs a reason of at least 10 characters")
    }
    const screening = screenBuyer(
      { name: input.buyerName, identifier: input.buyerIdentifier },
      await loadScreeningCandidates(tx, actor.tenantId, recovery.loanId, Number(today.slice(0, 4))),
    )
    const sale = await tx.remarketingSale.create({ data: {
      tenantId: actor.tenantId, recoveryId: recovery.id, channel: input.channel, buyerType: input.buyerType,
      buyerName: input.buyerName, buyerIdentifier: input.buyerIdentifier, buyerAddress: input.buyerAddress, buyerVatNumber: input.buyerVatNumber,
      priceInclVatCents: input.priceInclVatCents, valuationId: input.valuationId, highestValuationCents: highest, belowValuation,
      belowValuationReason: belowValuation ? input.belowValuationReason : null, relatedPartyMatch: screening.match,
      screeningResult: { match: screening.match, matches: screening.matches }, createdById: actor.userId,
    } })
    // The database also flags a buyer who carries the borrower's or a related client's ID number.
    const flagged = sale.relatedPartyMatch
    await logAuditStrict({
      ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_SALE_PROPOSED, entity: "RemarketingSale", entityId: sale.id,
      newValue: {
        recoveryId: recovery.id, channel: input.channel, buyerType: input.buyerType, priceInclVatCents: input.priceInclVatCents,
        valuationId: input.valuationId, highestValuationCents: highest, belowValuation, relatedPartyMatch: flagged,
      },
    }, tx)
    if (flagged) {
      await logAuditStrict({
        ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_RELATED_PARTY_FLAGGED, entity: "RemarketingSale", entityId: sale.id,
        newValue: { recoveryId: recovery.id, matches: screening.matches },
      }, tx)
    }
    return { kind: "done", id: sale.id, belowValuation, relatedPartyMatch: flagged, approvalRequired: approvalRequired({ belowValuation, relatedPartyMatch: flagged }) }
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
    if (!approvalRequired(sale)) throw new RecoveryRefusal("This sale needs no approval: it is at or above the valuation and the buyer matched no screened list")
    if (await actorIsBuyer(tx, actor.tenantId, actor.userId, { name: sale.buyerName, identifier: sale.buyerIdentifier })) throw new RecoveryRefusal(SELF_DEALING)
    if (sale.createdById === actor.userId) throw new RecoveryRefusal("A sale is approved by someone other than the person who proposed it")
    if (sale.approvedById) throw new RecoveryRefusal("The sale is already approved")
    await tx.remarketingSale.update({ where: { id: sale.id, tenantId: actor.tenantId }, data: { approvedById: actor.userId, approvedAt: new Date() } })
    await logAuditStrict({
      ...auditActor(actor), action: AuditAction.ASSET_REMARKETING_SALE_APPROVED, entity: "RemarketingSale", entityId: sale.id,
      newValue: { recoveryId: sale.recoveryId, belowValuation: sale.belowValuation, relatedPartyMatch: sale.relatedPartyMatch, proposedById: sale.createdById },
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
