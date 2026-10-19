/**
 * Dealer consent is evidence, not consent (spec deviation 8). The dealer
 * uploads the signed POPIA consent form (docType POPIA_CONSENT) and attests,
 * per data subject, the fixed statement below; the database checks the
 * document is that dealer's upload on the deal and the subject is the deal's
 * client or an active person of its entity (guardDealerConsentAttestation).
 *
 * A staff member then verifies it: the attestation gets verifiedById/At, the
 * document is marked verified, and ClientConsent.creditBureauEnquiry is
 * granted through computeConsentTransition (lib/consent.ts) with the staff
 * actor — all in one transaction, all audited. Bureau checks keep reading
 * ClientConsent unchanged.
 */
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { computeConsentTransition, type ConsentRow } from "@/lib/consent"
import { dealerAuditFields, type DealerActor, type StaffActor } from "./actor"
import { dealerDealWhere } from "./deals"
import { dealerMiss, dealerRefused, type DealerRefusal } from "./result"

export const DEALER_CONSENT_VERSION = "dealer-consent-v1"

// UNTESTED: legal — the lender's legal team confirms this wording (SLICE5.md, Review items).
export const DEALER_CONSENT_STATEMENT =
  "I confirm that the person named signed the uploaded consent form in my presence, that I checked their identity " +
  "document against them, and that the form is unaltered. The consent lets the lender obtain their credit " +
  "information from credit bureaus and process their personal information to assess this application."

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/** The people whose consent a deal needs: its sole proprietor, or every active person of its entity. */
export async function dealSubjects(db: Pick<Tx, "entityRelationship">, tenantId: string, deal: { clientId: string | null; entityId: string | null }): Promise<string[]> {
  if (deal.clientId) return [deal.clientId]
  if (!deal.entityId) return []
  const rows = await db.entityRelationship.findMany({ where: { tenantId, entityId: deal.entityId, active: true }, select: { clientId: true } })
  return [...new Set(rows.map((r) => r.clientId))]
}

export async function attestDealerConsent(
  actor: DealerActor,
  dealId: string,
  input: { documentId: unknown; clientIds: unknown },
): Promise<{ kind: "attested"; attestationIds: string[] } | DealerRefusal> {
  const clientIds = Array.isArray(input.clientIds) ? [...new Set(input.clientIds.filter((c): c is string => typeof c === "string"))] : []
  if (typeof input.documentId !== "string" || clientIds.length === 0 || clientIds.length !== (input.clientIds as unknown[]).length) {
    return dealerRefused(400, "Name the consent document and at least one person")
  }
  const documentId = input.documentId
  return prisma.$transaction(async (tx) => {
    const deal = await tx.assetFinanceDeal.findFirst({
      where: dealerDealWhere(actor, dealId),
      select: { id: true, status: true, dealerSubmittedAt: true, clientId: true, entityId: true },
    })
    if (!deal) return dealerMiss("Deal")
    if (deal.status !== "DRAFT" || deal.dealerSubmittedAt) return dealerRefused(409, "Consent is attested before the deal is submitted")
    const document = await tx.entityDocument.findFirst({
      where: { id: documentId, tenantId: actor.tenantId, dealId: deal.id, docType: "POPIA_CONSENT", uploadedByType: "dealer", deletedAt: null },
      select: { id: true },
    })
    if (!document) return dealerMiss("Consent document")
    const subjects = await dealSubjects(tx, actor.tenantId, deal)
    if (clientIds.some((id) => !subjects.includes(id))) return dealerRefused(422, "Each person must be the borrower or an active person of the business")
    const already = await tx.dealerConsentAttestation.findFirst({ where: { tenantId: actor.tenantId, dealId: deal.id, clientId: { in: clientIds } }, select: { id: true } })
    if (already) return dealerRefused(409, "Consent is already attested for one of these people")
    const audit = dealerAuditFields(actor)
    const attestationIds: string[] = []
    for (const clientId of clientIds) {
      const row = await tx.dealerConsentAttestation.create({
        data: {
          tenantId: actor.tenantId, dealId: deal.id, clientId, documentId: document.id, dealerUserId: actor.dealerUserId,
          statementVersion: DEALER_CONSENT_VERSION, statementText: DEALER_CONSENT_STATEMENT,
        },
        select: { id: true },
      })
      attestationIds.push(row.id)
      await logAuditStrict({
        tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
        action: AuditAction.DEALER_CONSENT_ATTESTED, entity: "DealerConsentAttestation", entityId: row.id,
        newValue: { dealId: deal.id, clientId, documentId: document.id, statementVersion: DEALER_CONSENT_VERSION, actor: audit.actor },
      }, tx)
    }
    return { kind: "attested" as const, attestationIds }
  })
}

const NO_CONSENT: ConsentRow = {
  creditBureauEnquiry: false, insuranceUnderwriting: false, smsMarketing: false, emailMarketing: false,
  thirdPartySharing: false, automatedDecisionMaking: false, withdrawnAt: null,
}

/** Staff verification (manage_asset_finance, checked by the route). */
export async function verifyDealerConsent(staff: StaffActor, dealId: string, attestationId: string): Promise<{ kind: "verified" } | DealerRefusal> {
  return prisma.$transaction(async (tx) => {
    const attestation = await tx.dealerConsentAttestation.findFirst({
      where: { id: attestationId, tenantId: staff.tenantId, dealId },
      select: { id: true, clientId: true, documentId: true, verifiedAt: true, document: { select: { verifiedAt: true, docType: true, entityId: true } } },
    })
    if (!attestation) return dealerMiss("Consent attestation")
    const now = new Date()
    const marked = await tx.dealerConsentAttestation.updateMany({
      where: { id: attestation.id, tenantId: staff.tenantId, verifiedAt: null },
      data: { verifiedById: staff.userId, verifiedAt: now },
    })
    if (marked.count !== 1) return dealerRefused(409, "This consent is already verified")
    const audit = (action: string, entity: string, entityId: string, newValue: Record<string, unknown>, oldValue?: Record<string, unknown>) =>
      logAuditStrict({ tenantId: staff.tenantId, userId: staff.userId, userEmail: staff.userEmail, action, entity, entityId, newValue, oldValue }, tx)
    await audit(AuditAction.DEALER_CONSENT_VERIFIED, "DealerConsentAttestation", attestation.id, { dealId, clientId: attestation.clientId, documentId: attestation.documentId })

    // One form may cover several people: it is verified with the first of them.
    const documentVerified = await tx.entityDocument.updateMany({
      where: { id: attestation.documentId, tenantId: staff.tenantId, verifiedAt: null, deletedAt: null },
      data: { verifiedAt: now, verifiedById: staff.userId },
    })
    if (documentVerified.count === 1) {
      await audit(AuditAction.ENTITY_DOCUMENT_VERIFIED, "EntityDocument", attestation.documentId, {
        businessEntityId: attestation.document.entityId, docType: attestation.document.docType, verifiedAt: now.toISOString(),
      })
    }

    const current = await tx.clientConsent.findUnique({ where: { clientId: attestation.clientId } })
    const reason = `Dealer consent ${attestation.id} verified`
    const transition = computeConsentTransition(current ?? NO_CONSENT, { creditBureauEnquiry: true }, { actorId: staff.userId, reason })
    if (transition.auditEvents.length === 0) return { kind: "verified" as const }
    const row = await tx.clientConsent.upsert({
      where: { clientId: attestation.clientId },
      create: { clientId: attestation.clientId, ...NO_CONSENT, capturedBy: staff.userId, ...transition.updates },
      update: transition.updates,
    })
    for (const event of transition.auditEvents) {
      if (event.action === AuditAction.CONSENT_PURPOSE_CHANGED) {
        await audit(event.action, "ClientConsent", row.id, { [event.purpose]: event.to, reason }, { [event.purpose]: event.from })
      } else {
        await audit(event.action, "ClientConsent", row.id, { purposes: event.purposes, reason })
      }
    }
    return { kind: "verified" as const }
  })
}
