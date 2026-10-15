import type { RemarketingBuyerType, SaleChannel } from "@prisma/client"
import { randsToCents } from "@/lib/asset-finance/money-input"
import type { Built } from "./recovery-forms"

// Labels, the proposal body and the approval rules the sale section shows.
// Presentation only: the screening, the below-valuation rule and the two-person
// rule are lib/asset-finance/recovery-sale.ts and the database's.

export const CHANNEL_LABELS: Record<SaleChannel, string> = {
  AUCTION: "Auction",
  DEALER: "Dealer",
  PRIVATE_TENDER: "Private tender",
  DEBTOR_OR_SURETY: "Debtor or surety",
}

export const BUYER_TYPE_LABELS: Record<RemarketingBuyerType, string> = { PERSON: "Person", ENTITY: "Business" }

export interface SaleForm {
  channel: SaleChannel
  buyerType: RemarketingBuyerType
  buyerName: string
  buyerIdentifier: string
  buyerAddress: string
  buyerVatNumber: string
  price: string
  valuationId: string
  belowValuationReason: string
}

export const emptySaleForm = (valuationId: string): SaleForm => ({
  channel: "AUCTION", buyerType: "PERSON", buyerName: "", buyerIdentifier: "", buyerAddress: "", buyerVatNumber: "", price: "", valuationId, belowValuationReason: "",
})

/** The reason box shows once the price is under the highest valuation offered (the server recomputes this from the database). */
export function priceBelowValuation(form: SaleForm, valuationCents: number[]): boolean {
  const cents = randsToCents(form.price)
  return cents !== null && valuationCents.length > 0 && cents < Math.max(...valuationCents)
}

/** POST .../recoveries/[id]/sales. Amounts are integer cents; the buyer's identifier is sent, never shown again. */
export function saleBody(form: SaleForm, belowValuation: boolean): Built<Record<string, unknown>> {
  const priceInclVatCents = randsToCents(form.price)
  const len = (value: string) => value.trim().length
  if (priceInclVatCents === null || priceInclVatCents <= 0) return { error: "Enter the price including VAT in rand, e.g. 640000.00" }
  if (!form.valuationId) return { error: "Choose the independent valuation the sale relies on" }
  if (len(form.buyerName) < 2) return { error: "Enter the buyer's name" }
  if (len(form.buyerIdentifier) < 3) return { error: "Enter the buyer's ID or registration number" }
  if (len(form.buyerAddress) < 5) return { error: "Enter the buyer's address" }
  if (belowValuation && len(form.belowValuationReason) < 10) return { error: "A price under the highest valuation needs a reason of at least 10 characters" }
  return { body: {
    channel: form.channel, buyerType: form.buyerType, buyerName: form.buyerName.trim(), buyerIdentifier: form.buyerIdentifier.trim(), buyerAddress: form.buyerAddress.trim(),
    priceInclVatCents, valuationId: form.valuationId,
    ...(form.buyerVatNumber.trim() ? { buyerVatNumber: form.buyerVatNumber.trim() } : {}),
    ...(belowValuation ? { belowValuationReason: form.belowValuationReason.trim() } : {}),
  } }
}

const KIND_LABELS: Record<string, string> = { BORROWER: "the borrower", RELATED_PARTY: "a related party", STAFF: "a staff member", COI_DECLARATION: "a conflict declaration" }

/** The screening result as a sentence: which lists matched, by kind only (the result holds no names). */
export function screeningSummary(result: unknown): string {
  const matches = (typeof result === "object" && result !== null && Array.isArray((result as { matches?: unknown }).matches)
    ? (result as { matches: { kind?: unknown; on?: unknown }[] }).matches : [])
  if (matches.length === 0) return "No match against the borrower, related parties, staff or conflict declarations"
  const parts = matches.map((m) => `${KIND_LABELS[String(m.kind)] ?? String(m.kind)} (${m.on === "IDENTIFIER" ? "ID" : "name"})`)
  return `Matched ${[...new Set(parts)].join(", ")}`
}

export interface SaleLike { status: string; belowValuation: boolean; relatedPartyMatch: boolean; createdById: string; approvedById: string | null }

export const saleNeedsApproval = (sale: Pick<SaleLike, "belowValuation" | "relatedPartyMatch">): boolean => sale.belowValuation || sale.relatedPartyMatch

export interface SaleActions { approve: boolean; complete: boolean; cancel: boolean; waitingOn: "approver" | "different-approver" | null }

/**
 * What a user can do with a sale: a second person approves one that needs it
 * (never its proposer), and it completes once approved or when it needs none.
 */
export function saleActions(sale: SaleLike, userId: string, perms: { canManage: boolean; canDecide: boolean }): SaleActions {
  if (sale.status !== "PENDING_APPROVAL") return { approve: false, complete: false, cancel: false, waitingOn: null }
  const needs = saleNeedsApproval(sale) && !sale.approvedById
  const ownProposal = sale.createdById === userId
  return {
    approve: needs && perms.canDecide && !ownProposal,
    complete: perms.canManage && !needs,
    cancel: perms.canManage,
    waitingOn: needs ? (perms.canDecide && ownProposal ? "different-approver" : "approver") : null,
  }
}
