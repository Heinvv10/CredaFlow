import { AuditAction, logAuditStrict } from "@/lib/audit"
import { calculateCreditLifeMonthlyPremiumCents, CREDIT_LIFE_DISCLOSURE_VERSION, CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, type CreditLifeElection } from "@/lib/insurance/credit-life-election"
import { createCreditLifeDisclosureSha256, createCreditLifeNoOfferDisclosureSha256 } from "@/lib/insurance/credit-life-election.server"
import { creditLifeOfferFindFirstArgs } from "@/lib/insurance/credit-life-offer"
import type { RegimeTx } from "./classification"

export type AssetCreditLifeElectionResult =
  | { kind: "not_found" }
  | { kind: "not_open" }
  | { kind: "offer_required" }
  | { kind: "entity_decline_required" }
  | { kind: "recorded"; offered: boolean; monthlyPremiumCents: number }

export async function recordAssetCreditLifeElection(
  tx: RegimeTx,
  args: { tenantId: string; clientId: string; clientEmail?: string | null; dealId: string; election: CreditLifeElection },
): Promise<AssetCreditLifeElectionResult> {
  const deal = await tx.assetFinanceDeal.findFirst({
    where: { id: args.dealId, tenantId: args.tenantId, OR: [
      { clientId: args.clientId },
      { entity: { relationships: { some: { clientId: args.clientId, active: true, role: { in: ["DIRECTOR", "MEMBER", "TRUSTEE", "AUTHORISED_SIGNATORY"] } } } } },
    ] },
    select: { status: true, entityId: true, application: { select: { id: true, appliedAmount: true, appliedTermDays: true, pasqDocumentId: true } } },
  })
  if (!deal) return { kind: "not_found" }
  if (!["SUBMITTED", "REFERRED"].includes(deal.status) || deal.application.pasqDocumentId !== null) return { kind: "not_open" }
  if (deal.entityId && args.election === "ACCEPTED") return { kind: "entity_decline_required" }
  const offer = await tx.insuranceProduct.findFirst(creditLifeOfferFindFirstArgs(args.tenantId))
  if ((!offer || !offer.insurerId || !offer.insurer) && args.election === "ACCEPTED") return { kind: "offer_required" }
  const acknowledgedAt = new Date()
  const principalCents = deal.application.appliedAmount
  const termDays = deal.application.appliedTermDays
  const validOffer = offer && offer.insurerId && offer.insurer ? { ...offer, insurerId: offer.insurerId, insurer: offer.insurer } : null
  const monthlyPremiumCents = validOffer ? calculateCreditLifeMonthlyPremiumCents(principalCents) : 0
  const version = validOffer ? CREDIT_LIFE_DISCLOSURE_VERSION : CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
  const election = validOffer ? args.election : "DECLINED" as const
  const sha256 = validOffer
    ? createCreditLifeDisclosureSha256({
        version: CREDIT_LIFE_DISCLOSURE_VERSION, election, principalCents, termDays, monthlyPremiumCents,
        productId: validOffer.id, productName: validOffer.name, insurerId: validOffer.insurerId, insurerName: validOffer.insurer.name,
      })
    : createCreditLifeNoOfferDisclosureSha256({ version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION, election: "DECLINED", principalCents, termDays })
  await tx.loanApplication.update({
    where: { id: deal.application.id, tenantId: args.tenantId },
    data: {
      creditLifeElection: election,
      creditLifeProductId: validOffer?.id ?? null,
      creditLifeProductName: validOffer?.name ?? null,
      creditLifeInsurerId: validOffer?.insurerId ?? null,
      creditLifeInsurerName: validOffer?.insurer.name ?? null,
      creditLifeMonthlyPremiumCents: monthlyPremiumCents,
      creditLifeDisclosureVersion: version,
      creditLifeDisclosureSha256: sha256,
      creditLifeDisclosureAcknowledgedAt: acknowledgedAt,
      creditLifeDisclosureAcknowledgedBy: args.clientId,
      ...(deal.entityId ? { ncaRepresentativeClientId: args.clientId } : {}),
    },
  })
  await logAuditStrict({
    tenantId: args.tenantId,
    userEmail: args.clientEmail ?? undefined,
    action: AuditAction.ASSET_CREDIT_LIFE_ELECTED,
    entity: "AssetFinanceDeal",
    entityId: args.dealId,
    newValue: { clientId: args.clientId, election, offered: !!validOffer, monthlyPremiumCents, disclosureSha256: sha256 },
  }, tx)
  return { kind: "recorded", offered: !!validOffer, monthlyPremiumCents }
}
