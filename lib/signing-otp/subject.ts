/**
 * What a signing OTP is bound to: the client, the thing being signed and the
 * SHA-256 of the exact bytes the signer is shown. Each purpose reads the same
 * digest its signing route checks:
 *
 *  - AGREEMENT     LoanApplication.agreementDocumentSha256 (agreement/sign)
 *  - DEBIT_MANDATE LoanApplication.debitMandateDraftSha256 (debit-mandate/sign)
 *  - DOCUMENT      ClientDocument.contentSha256            (documents/[id]/sign)
 *
 * Only a subject that is still awaiting that signature resolves.
 */
import type { SigningOtpPurpose } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { DEALER_CONTACT_UNVERIFIED, dealerContactUnverified } from "@/lib/clients/dealer-contact"
import type { OtpRecipient } from "./deliver"

export const SIGNING_OTP_PURPOSES: readonly SigningOtpPurpose[] = ["AGREEMENT", "DEBIT_MANDATE", "DOCUMENT", "DEAL_DOCUMENT"]

export const DOCUMENT_LABELS: Record<SigningOtpPurpose, string> = {
  AGREEMENT: "credit agreement",
  DEBIT_MANDATE: "debit order mandate",
  DOCUMENT: "document",
  DEAL_DOCUMENT: "finance document",
}

export type SigningSubject = {
  tenantId: string
  clientId: string
  purpose: SigningOtpPurpose
  subjectId: string
  documentSha256: string
  recipient: OtpRecipient
}

export type SubjectResult = { ok: true; subject: SigningSubject } | { ok: false; status: number; error: string }

const clientSelect = {
  select: { firstName: true, lastName: true, email: true, whatsapp: true, createdByDealerId: true, dealerContactVerifiedAt: true },
} as const

const notAwaiting = (what: string): Extract<SubjectResult, { ok: false }> =>
  ({ ok: false, status: 409, error: `This ${what} is not waiting for a signature.` })

/** A code is never sent to contact details a dealer typed that staff have not verified (lib/clients/dealer-contact.ts). */
export async function resolveSigningSubject(
  tenantId: string,
  purpose: SigningOtpPurpose,
  subjectId: string,
): Promise<SubjectResult> {
  const resolved = await resolveSubject(tenantId, purpose, subjectId)
  if (!resolved.ok) return resolved
  if (dealerContactUnverified(resolved.contact)) return { ok: false, status: 409, error: DEALER_CONTACT_UNVERIFIED }
  return { ok: true, subject: resolved.subject }
}

type Contact = { createdByDealerId: string | null; dealerContactVerifiedAt: Date | null }

async function resolveSubject(
  tenantId: string,
  purpose: SigningOtpPurpose,
  subjectId: string,
): Promise<{ ok: true; subject: SigningSubject; contact: Contact } | Extract<SubjectResult, { ok: false }>> {
  if (purpose === "DEAL_DOCUMENT") {
    // The asset-finance signer row; its digest is what both e-sign paths
    // (recordESignature, signAssetNcaAgreement) bind the signature to.
    const signer = await prisma.dealSigner.findFirst({
      where: { id: subjectId, tenantId },
      select: { clientId: true, method: true, documentSha256: true, deal: { select: { status: true } }, client: clientSelect },
    })
    if (!signer) return { ok: false, status: 404, error: "Document not found." }
    if (signer.method !== null || signer.deal.status !== "APPROVED") return notAwaiting("document")
    if (!isSha256Digest(signer.documentSha256)) {
      return { ok: false, status: 422, error: "The document has not been prepared for signing yet." }
    }
    return {
      ok: true,
      subject: { tenantId, clientId: signer.clientId, purpose, subjectId, documentSha256: signer.documentSha256, recipient: signer.client },
      contact: signer.client,
    }
  }
  if (purpose === "DOCUMENT") {
    const doc = await prisma.clientDocument.findFirst({
      where: { id: subjectId, tenantId, deletedAt: null },
      select: { clientId: true, docType: true, contentSha256: true, signatureState: true, client: clientSelect },
    })
    if (!doc) return { ok: false, status: 404, error: "Document not found." }
    // These two have their own workflows and their own purposes.
    if (doc.docType === "CREDIT_AGREEMENT" || doc.docType === "DEBIT_MANDATE") return notAwaiting("document")
    if (doc.signatureState === "signed") return notAwaiting("document")
    if (!isSha256Digest(doc.contentSha256)) {
      return { ok: false, status: 422, error: "This document has no integrity digest, so a signing code cannot be bound to it." }
    }
    return {
      ok: true,
      subject: { tenantId, clientId: doc.clientId, purpose, subjectId, documentSha256: doc.contentSha256, recipient: doc.client },
      contact: doc.client,
    }
  }

  const app = await prisma.loanApplication.findFirst({
    where: { id: subjectId, tenantId },
    select: {
      clientId: true, status: true, repaymentMethod: true,
      agreementDocumentSha256: true, agreementSignedAt: true,
      debitMandateDraftSha256: true, debitMandateSignedAt: true,
      client: clientSelect,
    },
  })
  if (!app || !app.clientId || !app.client) return { ok: false, status: 404, error: "Application not found." }
  if (app.status !== "APPROVED") return notAwaiting("application")

  let digest: string | null
  if (purpose === "AGREEMENT") {
    if (app.agreementSignedAt) return notAwaiting("agreement")
    digest = app.agreementDocumentSha256
  } else {
    if (app.repaymentMethod !== "DEBIT_ORDER" || !app.agreementSignedAt || app.debitMandateSignedAt) {
      return notAwaiting("debit mandate")
    }
    digest = app.debitMandateDraftSha256
  }
  if (!isSha256Digest(digest)) {
    return { ok: false, status: 422, error: `The ${DOCUMENT_LABELS[purpose]} has not been prepared for signing yet.` }
  }
  return {
    ok: true,
    subject: { tenantId, clientId: app.clientId, purpose, subjectId, documentSha256: digest, recipient: app.client },
    contact: app.client,
  }
}
