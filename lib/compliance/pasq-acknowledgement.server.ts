import { prisma } from "@/lib/prisma"
import { documentBytesMatchSha256 } from "@/lib/documents/content-integrity"
import { readFile } from "@/lib/storage"
import { AuditAction } from "@/lib/audit"

/**
 * THE single writer of PASQ acknowledgement evidence (NCA s.92(1)).
 *
 * Two surfaces reach it: the portal, where the consumer is signed in, and the
 * one-time SMS/WhatsApp link, where they are not. Origination is telephonic and
 * online, so most consumers never hold a portal account — but the evidence
 * recorded has to be identical either way, because it is the same legal act.
 * Keeping one writer is what guarantees that; the channel only ever adds
 * descriptive fields to the audit row.
 *
 * The consumer is ALWAYS the acknowledging party of record. There is no staff
 * path: a staff checkbox asserting "the consumer read it" is the credit
 * provider attesting to the consumer's own act, which is not acknowledgement.
 */

export type PasqAcknowledgementMethod = "portal" | "token_link"

export interface PasqAcknowledgementResult {
  ok: boolean
  status: number
  error?: string
  acknowledgedAt?: Date
  existing?: boolean
}

interface RecordArgs {
  tenantId: string
  applicationId: string
  documentSha256: string
  /** The consumer. Never a staff id — every downstream gate pins this to the
   * application's own client. */
  clientId: string
  clientEmail: string | null
  method: PasqAcknowledgementMethod
  ipAddress: string | null
  userAgent: string | null
  /** Channel-specific evidence merged into the audit row (token id, channel). */
  auditEvidence?: Record<string, unknown>
}

function reject(status: number, error: string): PasqAcknowledgementResult {
  return { ok: false, status, error }
}

export async function recordPasqAcknowledgement(
  args: RecordArgs,
): Promise<PasqAcknowledgementResult> {
  const { tenantId, applicationId, documentSha256 } = args
  const application = await prisma.loanApplication.findUnique({
    where: { id: applicationId, tenantId },
    select: {
      id: true,
      clientId: true,
      status: true,
      updatedAt: true,
      agreementGeneratedAt: true,
      pasqGeneratedAt: true,
      pasqDocumentId: true,
      pasqDocumentSha256: true,
      pasqAcknowledgedAt: true,
      pasqAcknowledgedBy: true,
      pasqAcknowledgedSha256: true,
    },
  })
  if (!application) return reject(404, "Application not found")
  if (application.clientId !== args.clientId) {
    return reject(403, "Only the consumer named on the application may acknowledge its quotation.")
  }
  // s.92(1) attaches the quotation to entering into the agreement, so the
  // acknowledgement belongs to the signing ceremony: after the credit decision,
  // before the agreement PDF exists.
  if (application.status !== "APPROVED") {
    return reject(409, "The quotation is acknowledged at the signing ceremony, on an approved application.")
  }
  if (application.agreementGeneratedAt) {
    return reject(409, "The agreement has already been generated; the quotation must be acknowledged before it.")
  }
  if (
    !application.pasqGeneratedAt
    || !application.pasqDocumentId
    || application.pasqDocumentSha256 !== documentSha256
  ) {
    return reject(409, "The supplied PASQ hash does not match the current generated document.")
  }
  const pasqGeneratedAt = application.pasqGeneratedAt

  if (
    application.pasqAcknowledgedAt
    && application.pasqAcknowledgedBy === args.clientId
    && application.pasqAcknowledgedSha256 === documentSha256
  ) {
    return {
      ok: true,
      status: 200,
      acknowledgedAt: application.pasqAcknowledgedAt,
      existing: true,
    }
  }
  if (
    application.pasqAcknowledgedAt
    || application.pasqAcknowledgedBy
    || application.pasqAcknowledgedSha256
  ) {
    return reject(409, "The application contains a conflicting PASQ acknowledgement and requires compliance reconciliation.")
  }

  const document = await prisma.clientDocument.findFirst({
    where: {
      id: application.pasqDocumentId,
      tenantId,
      clientId: application.clientId,
      docType: "FORM_20_PRE_AGREEMENT",
      deletedAt: null,
      storagePath: { not: null },
      contentSha256: documentSha256,
    },
  })
  if (!document?.storagePath) {
    return reject(422, "The bound PASQ document is unavailable.")
  }
  // Proof the quotation was actually put in front of the consumer before they
  // acknowledged it — the evidence s.92(1) turns on. Both channels stream the
  // bytes to the consumer's own device and write a client-typed access log, so
  // the requirement is the same on both.
  const priorView = await prisma.documentAccessLog.findFirst({
    where: {
      documentId: document.id,
      accessorType: "client",
      accessorId: args.clientId,
      action: "view",
      createdAt: { gte: pasqGeneratedAt },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  })
  if (!priorView) {
    return reject(422, "Open and review the current PASQ before acknowledging it.")
  }
  let bytes: Buffer
  try {
    bytes = await readFile(document.storagePath)
  } catch {
    return reject(422, "The bound PASQ bytes are unavailable.")
  }
  if (!documentBytesMatchSha256(bytes, documentSha256)) {
    return reject(422, "The PASQ bytes failed their integrity check and cannot be acknowledged.")
  }

  const acknowledgedAt = new Date()
  // An interactive transaction only rolls back on THROW. Returning false after
  // the first write has succeeded would commit the acknowledgement while
  // reporting failure, so the document mark aborts the whole transaction.
  const pasqDocumentMarkConflict = new Error("pasq_document_mark_conflict")
  let saved: boolean
  try {
    saved = await prisma.$transaction(async (tx) => {
      const changed = await tx.loanApplication.updateMany({
        where: {
          id: applicationId,
          tenantId,
          status: "APPROVED",
          updatedAt: application.updatedAt,
          agreementGeneratedAt: null,
          pasqDocumentId: document.id,
          pasqDocumentSha256: documentSha256,
          pasqAcknowledgedAt: null,
          pasqAcknowledgedBy: null,
          pasqAcknowledgedSha256: null,
        },
        data: {
          pasqAcknowledgedAt: acknowledgedAt,
          pasqAcknowledgedBy: args.clientId,
          pasqAcknowledgedSha256: documentSha256,
          // Approval no longer stamps this — it runs before any quotation
          // exists. The digest every downstream gate pins is established HERE,
          // at acknowledgement, so it names the exact document the consumer
          // actually accepted rather than one merely issued to them.
          approvedPasqDocumentSha256: documentSha256,
        },
      })
      if (changed.count !== 1) return false
      // An acknowledged quotation must be distinguishable from one never opened
      // on the document itself. The consumer does not SIGN a quotation, so
      // signedAt stays untouched.
      const documentMarked = await tx.clientDocument.updateMany({
        where: {
          id: document.id,
          tenantId,
          // Equal to application.clientId (checked above); a closure loses that narrowing.
          clientId: args.clientId,
          docType: "FORM_20_PRE_AGREEMENT",
          deletedAt: null,
          contentSha256: documentSha256,
        },
        data: { signatureState: "acknowledged" },
      })
      if (documentMarked.count !== 1) throw pasqDocumentMarkConflict
      await tx.auditLog.create({
        data: {
          tenantId,
          // AuditLog.userId is a foreign key to the staff User table. Portal
          // identities are Client rows, so recording a client id here rolls
          // back the acknowledgement transaction. The consumer is named in the
          // structured evidence instead.
          userId: null,
          userEmail: args.clientEmail,
          action: AuditAction.PASQ_ACKNOWLEDGED,
          entity: "LoanApplication",
          entityId: applicationId,
          ipAddress: args.ipAddress,
          newValue: {
            documentId: document.id,
            documentSha256,
            generatedAt: pasqGeneratedAt.toISOString(),
            acknowledgedAt: acknowledgedAt.toISOString(),
            priorViewId: priorView.id,
            priorViewAt: priorView.createdAt.toISOString(),
            actorType: "client",
            actorClientId: args.clientId,
            method: args.method,
            userAgent: args.userAgent,
            ...(args.auditEvidence ?? {}),
          },
        },
      })
      return true
    })
  } catch (error) {
    if (error !== pasqDocumentMarkConflict) throw error
    saved = false
  }
  if (!saved) {
    return reject(409, "The PASQ or application changed before acknowledgement; refresh and review the current document.")
  }
  return { ok: true, status: 200, acknowledgedAt }
}
