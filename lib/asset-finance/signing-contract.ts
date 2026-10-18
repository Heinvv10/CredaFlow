// APPROVED → CONTRACTED once every required signature is in (goal §4.9). The
// route answers 409 with the outstanding signers; the database refuses the
// same move on its own (guardAssetDealContract), so no other path can skip it.
// The payout checklist is created in the same transaction (§4.10).
//
// "Required" is the signer set fixed when the documents were prepared
// (AssetFinanceDeal.preparedSigners), not the entity's people now. And the
// agreement is rendered again from the deal as it stands: its sha256 must be
// the digest the signers signed, or the deal, its asset or its rate changed
// since signing and is refused (agreement_changed).
import type { AssetDealStatus, DealDocumentKind } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { createPayoutChecklist } from "./payout-checklist-store"
import { loadDealDocumentData } from "./documents/deal-document-data"
import { renderDealDocument } from "./documents/render"
import { pinnedIssuance } from "./documents/templates/issuance"
import { outstandingSigners, type Outstanding } from "./signing"
import { lockDeal, preparedRequiredSigners, type SigningActor } from "./signing-prepare"
import { providerCountersignatureEnvelopeSha256, providerCountersignatureSha256 } from "@/lib/compliance/provider-countersign"

export interface OutstandingView extends Outstanding {
  name: string
}

export type ContractResult =
  | { kind: "not_found" }
  | { kind: "not_approved"; status: AssetDealStatus }
  | { kind: "no_authority" }
  | { kind: "incomplete"; outstanding: OutstandingView[] }
  | { kind: "agreement_changed" }
  | { kind: "provider_signature_required" }
  | { kind: "contracted" }

export async function contractDeal(actor: SigningActor, dealId: string, providerSignature?: string): Promise<ContractResult> {
  const { tenantId } = actor
  return prisma.$transaction(async (tx) => {
    const deal = await lockDeal(tx, tenantId, dealId)
    if (!deal) return { kind: "not_found" }
    if (deal.status !== "APPROVED") return { kind: "not_approved", status: deal.status }
    const required = await preparedRequiredSigners(tx, tenantId, dealId)
    if (!required.some((s) => s.document === "AGREEMENT")) return { kind: "no_authority" }
    const rows = await tx.dealSigner.findMany({
      where: { tenantId, dealId },
      select: {
        clientId: true, document: true, method: true, signedAt: true, signatureSha256: true,
        signatureData: true, scanDocumentId: true, confirmedById: true, confirmedAt: true, documentSha256: true, issuanceId: true,
      },
    })
    const outstanding = outstandingSigners(required, rows)
    if (outstanding.length > 0) {
      const clients = await tx.client.findMany({
        where: { tenantId, id: { in: outstanding.map((o) => o.clientId) } },
        select: { id: true, firstName: true, lastName: true },
      })
      const names = new Map(clients.map((c) => [c.id, `${c.firstName} ${c.lastName}`]))
      return { kind: "incomplete", outstanding: outstanding.map((o) => ({ ...o, name: names.get(o.clientId) ?? o.clientId })) }
    }
    const application = await tx.assetFinanceDeal.findFirstOrThrow({ where: { id: dealId, tenantId }, select: {
      entityId: true, application: { select: { id: true, ncaRegime: true, ncaRepresentativeClientId: true, agreementDocumentSha256: true } },
    } })
    const entityNca = application.entityId !== null && application.application.ncaRegime === "NCA"
    const agreement = rows.find((r) => r.document === "AGREEMENT")
    if (!agreement) return { kind: "not_found" }
    let agreementSha256 = agreement.documentSha256
    if (entityNca) {
      const representative = rows.find((row) => row.document === "AGREEMENT" && row.clientId === application.application.ncaRepresentativeClientId)
      const signature = providerSignature?.trim() ?? ""
      if (!representative?.signedAt || representative.method !== "E_SIGN" || !representative.signatureData || signature.length < 3 || signature.length > 120) {
        return { kind: "provider_signature_required" }
      }
      const provider = await tx.user.findFirst({ where: { id: actor.userId, tenantId, active: true }, select: { name: true, email: true } })
      if (!provider || !representative.documentSha256) return { kind: "provider_signature_required" }
      const countersignedAt = new Date()
      const providerName = provider.name?.trim() || provider.email
      const providerSha256 = providerCountersignatureSha256(signature)
      const envelopeSha256 = providerCountersignatureEnvelopeSha256({
        tenantId, applicationId: application.application.id, clientId: representative.clientId,
        documentSha256: representative.documentSha256, consumerSignedAt: representative.signedAt,
        consumerSignedMethod: "portal", consumerSignerId: representative.clientId,
        consumerSignatureSha256: providerCountersignatureSha256(representative.signatureData),
        providerCountersignedAt: countersignedAt, providerSignerId: actor.userId, providerSignerName: providerName,
        providerSignerEmail: provider.email, providerSignatureSha256: providerSha256,
      })
      await tx.loanApplication.update({ where: { id: application.application.id, tenantId }, data: {
        agreementSignedAt: representative.signedAt, agreementSignedMethod: "portal", agreementSignatureData: representative.signatureData,
        agreementCountersignedAt: countersignedAt, agreementCountersignedById: actor.userId,
        agreementCountersignedByName: providerName, agreementCountersignedByEmail: provider.email,
        agreementCountersignatureData: signature, agreementCountersignatureSha256: providerSha256,
        agreementCountersignatureEnvelopeSha256: envelopeSha256,
        agreementCountersignedDocumentSha256: representative.documentSha256,
      } })
      agreementSha256 = representative.documentSha256
    } else {
      // Throws DealDocumentError / LenderIdentityError: the route refuses with the reason.
      const data = await loadDealDocumentData(tx, tenantId, dealId)
      if (!data) return { kind: "not_found" }
      // Re-rendered with the version and identity it was issued with (a row
      // prepared before lender templates has none: its own signature stands).
      const pinned = await pinnedIssuance(tx, tenantId, agreement.issuanceId)
      const fresh = await renderDealDocument(pinned ? { ...data, lender: pinned.lender } : data, "AGREEMENT", agreement.clientId, pinned?.wording)
      if (rows.some((r) => r.document === "AGREEMENT" && r.documentSha256 !== fresh.sha256)) return { kind: "agreement_changed" }
      agreementSha256 = fresh.sha256
    }
    await tx.assetFinanceDeal.updateMany({ where: { id: dealId, tenantId, status: "APPROVED" }, data: { status: "CONTRACTED" } })
    await createPayoutChecklist(tx, tenantId, dealId)
    const signed: { clientId: string; document: DealDocumentKind; method: string | null }[] = rows.map((r) => ({
      clientId: r.clientId, document: r.document, method: r.method,
    }))
    await logAuditStrict(
      {
        tenantId,
        userId: actor.userId,
        userEmail: actor.userEmail ?? undefined,
        action: AuditAction.ASSET_DEAL_CONTRACTED,
        entity: "AssetFinanceDeal",
        entityId: dealId,
        oldValue: { status: "APPROVED" },
        newValue: { status: "CONTRACTED", signers: signed, agreementSha256 },
      },
      tx,
    )
    return { kind: "contracted" }
  })
}
