/**
 * Dealer consent is evidence, not consent (spec deviation 8). The dealer
 * uploads the signed POPIA consent form (docType POPIA_CONSENT) and attests,
 * per data subject, the fixed statement below and how the form was signed (in
 * person, or remotely with how identity was checked: dealer-consent-v2,
 * CHECK DealerConsentAttestation_signing_method); the database checks the
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

export const DEALER_CONSENT_VERSION = "dealer-consent-v2"

export const DEALER_CONSENT_SIGNING_METHODS = ["IN_PERSON", "REMOTE"] as const
export type DealerConsentSigningMethod = (typeof DEALER_CONSENT_SIGNING_METHODS)[number]
export const REMOTE_IDENTITY_CHECK_MIN = 10
export const REMOTE_IDENTITY_CHECK_MAX = 500

// UNTESTED: legal — the lender's legal team confirms this wording (SLICE5-FOLLOWUPS.md part D). It must be true for
// a form signed in front of the dealer and for one signed remotely, so it says nothing of where the person was.
export const DEALER_CONSENT_STATEMENT =
  "I confirm that the uploaded consent form was signed by the person named, that their identity was checked in the way " +
  "recorded below, and that the form has not been altered since it was signed or, if it was signed remotely, since the " +
  "dealership received it. The consent lets the lender obtain their credit information from credit bureaus and process " +
  "their personal information to assess this application."

/** The line the attestation adds for how the form was signed (part of the snapshot). */
export function dealerConsentMethodLine(method: DealerConsentSigningMethod, remoteIdentityCheck: string | null): string {
  return method === "IN_PERSON"
    ? "Signed in my presence: I checked their identity document against them."
    : `Signed remotely. How their identity was checked: ${remoteIdentityCheck ?? ""}`
}

/** The text an attestation snapshots: the statement, then the signing method line. */
export function dealerConsentSnapshot(method: DealerConsentSigningMethod, remoteIdentityCheck: string | null): string {
  return `${DEALER_CONSENT_STATEMENT}\n${dealerConsentMethodLine(method, remoteIdentityCheck)}`
}

/** `{ signingMethod, remoteIdentityCheck }`: REMOTE needs the identity check (10 to 500 characters), IN_PERSON none. */
export function parseSigningMethod(input: { signingMethod?: unknown; remoteIdentityCheck?: unknown }):
  { signingMethod: DealerConsentSigningMethod; remoteIdentityCheck: string | null } | string {
  const method = DEALER_CONSENT_SIGNING_METHODS.find((m) => m === input.signingMethod)
  if (!method) return "Say how the consent form was signed: in person or remotely"
  const check = typeof input.remoteIdentityCheck === "string" ? input.remoteIdentityCheck.trim() : ""
  if (method === "IN_PERSON") return check ? "An identity check is described only for a form signed remotely" : { signingMethod: method, remoteIdentityCheck: null }
  // One line, as the database requires: a line break could forge another method line in the snapshot.
  if (/[\u0000-\u001f\u007f]/.test(check)) return "Describe the identity check on one line"
  // Characters as the database counts them (code points), not UTF-16 units.
  const characters = [...check].length
  if (characters < REMOTE_IDENTITY_CHECK_MIN || characters > REMOTE_IDENTITY_CHECK_MAX) {
    return `Describe how you checked the person's identity for a remote signing (${REMOTE_IDENTITY_CHECK_MIN} to ${REMOTE_IDENTITY_CHECK_MAX} characters)`
  }
  return { signingMethod: method, remoteIdentityCheck: check }
}

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0]

/**
 * The people whose consent the dealer attests: its sole proprietor, or every
 * active person of its entity that this dealer captured. A person the lender
 * added is the lender's to ask (DealerConsentAttestation_subject_captured).
 */
export async function dealSubjects(
  db: Pick<Tx, "entityRelationship">,
  tenantId: string,
  dealerId: string,
  deal: { clientId: string | null; entityId: string | null },
): Promise<string[]> {
  if (deal.clientId) return [deal.clientId]
  if (!deal.entityId) return []
  const rows = await db.entityRelationship.findMany({
    where: { tenantId, entityId: deal.entityId, active: true, client: { createdByDealerId: dealerId } },
    select: { clientId: true },
  })
  return [...new Set(rows.map((r) => r.clientId))]
}

export async function attestDealerConsent(
  actor: DealerActor,
  dealId: string,
  input: { documentId: unknown; clientIds: unknown; signingMethod?: unknown; remoteIdentityCheck?: unknown },
): Promise<{ kind: "attested"; attestationIds: string[] } | DealerRefusal> {
  const signing = parseSigningMethod(input)
  if (typeof signing === "string") return dealerRefused(400, signing)
  const clientIds = Array.isArray(input.clientIds) ? [...new Set(input.clientIds.filter((c): c is string => typeof c === "string"))] : []
  if (typeof input.documentId !== "string" || clientIds.length === 0 || clientIds.length !== (input.clientIds as unknown[]).length) {
    return dealerRefused(400, "Name the consent document and at least one person")
  }
  const documentId = input.documentId
  return prisma.$transaction(async (tx) => {
    const deal = await tx.assetFinanceDeal.findFirst({
      where: dealerDealWhere(actor, dealId),
      select: { id: true, status: true, dealerSubmittedAt: true, clientId: true, entityId: true, dealerPurge: { select: { id: true } } },
    })
    if (!deal) return dealerMiss("Deal")
    if (deal.dealerPurge) return dealerRefused(409, "This draft was closed and its details erased: start a new deal")
    if (deal.status !== "DRAFT" || deal.dealerSubmittedAt) return dealerRefused(409, "Consent is attested before the deal is submitted")
    const document = await tx.entityDocument.findFirst({
      where: { id: documentId, tenantId: actor.tenantId, dealId: deal.id, docType: "POPIA_CONSENT", uploadedByType: "dealer", deletedAt: null },
      select: { id: true },
    })
    if (!document) return dealerMiss("Consent document")
    const subjects = await dealSubjects(tx, actor.tenantId, actor.dealerId, deal)
    if (clientIds.some((id) => !subjects.includes(id))) {
      return dealerRefused(422, "Each person must be the borrower or an active person of the business you captured: the lender records consent for a person it added")
    }
    const already = await tx.dealerConsentAttestation.findFirst({ where: { tenantId: actor.tenantId, dealId: deal.id, clientId: { in: clientIds } }, select: { id: true } })
    if (already) return dealerRefused(409, "Consent is already attested for one of these people")
    const audit = dealerAuditFields(actor)
    const attestationIds: string[] = []
    for (const clientId of clientIds) {
      const row = await tx.dealerConsentAttestation.create({
        data: {
          tenantId: actor.tenantId, dealId: deal.id, clientId, documentId: document.id, dealerUserId: actor.dealerUserId,
          statementVersion: DEALER_CONSENT_VERSION,
          statementText: dealerConsentSnapshot(signing.signingMethod, signing.remoteIdentityCheck),
          signingMethod: signing.signingMethod, remoteIdentityCheck: signing.remoteIdentityCheck,
        },
        select: { id: true },
      })
      attestationIds.push(row.id)
      await logAuditStrict({
        tenantId: actor.tenantId, userId: audit.userId, userEmail: audit.userEmail,
        action: AuditAction.DEALER_CONSENT_ATTESTED, entity: "DealerConsentAttestation", entityId: row.id,
        newValue: {
          dealId: deal.id, clientId, documentId: document.id, statementVersion: DEALER_CONSENT_VERSION,
          // The identity note stays on the attestation only: an audit row is never erased.
          signingMethod: signing.signingMethod, actor: audit.actor,
        },
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
