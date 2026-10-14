// Wet-ink signing (goal §4.9, decision 2a.5): a staff member uploads the scan
// of a document signed on paper for one signer row; a DIFFERENT staff member
// confirms it. The scan is an EntityDocument of type SIGNED_* bound to the
// deal; the upload, the binding and the audit row commit together. Until it is
// confirmed a wrong scan can be replaced; once confirmed the row is frozen.
//
// The database holds the same rules: DealSigner_wet_ink_four_eyes (confirmer
// is not the uploader) and guardDealSigner (the scan is this deal's SIGNED_*
// document of the right kind, uploaded by the recorded user).
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { storeEntityDocument, type ParsedEntityUpload } from "./entity-document-io"
import { SIGNED_DOC_TYPE, signerState } from "./signing"
import type { SigningActor } from "./signing-prepare"

const SIGNER_SELECT = {
  id: true, dealId: true, clientId: true, document: true, method: true, signedAt: true, signatureSha256: true,
  scanDocumentId: true, scanUploadedById: true, confirmedById: true, confirmedAt: true,
  deal: { select: { status: true, entityId: true } },
} as const

export class SignerChangedError extends Error {
  constructor() {
    super("The signer changed while the scan was being recorded")
    this.name = "SignerChangedError"
  }
}

type Common = { kind: "not_found" } | { kind: "not_open"; reason: string } | { kind: "done"; scanDocumentId: string }
export type UploadResult = Common | { kind: "wrong_type"; expected: string }
export type ConfirmResult = Common | { kind: "four_eyes" } | { kind: "scan_changed" }

function findSigner(tenantId: string, dealId: string, signerId: string) {
  return prisma.dealSigner.findFirst({ where: { id: signerId, dealId, tenantId }, select: SIGNER_SELECT })
}

export async function uploadWetInkScan(actor: SigningActor, dealId: string, signerId: string, upload: ParsedEntityUpload): Promise<UploadResult> {
  const signer = await findSigner(actor.tenantId, dealId, signerId)
  if (!signer) return { kind: "not_found" }
  if (!signer.deal.entityId) return { kind: "not_open", reason: "Natural-person NCA deals use the prescribed NCA signing flow" }
  const entityId = signer.deal.entityId
  if (signer.deal.status !== "APPROVED") return { kind: "not_open", reason: "Scans are recorded only while the deal is APPROVED" }
  const state = signerState(signer)
  if (state !== "PENDING" && state !== "AWAITING_CONFIRMATION") return { kind: "not_open", reason: "This signer has already signed" }
  const expected = SIGNED_DOC_TYPE[signer.document]
  if (upload.docType !== expected) return { kind: "wrong_type", expected }

  const previousScan = signer.scanDocumentId
  const stored = await storeEntityDocument({
    tenantId: actor.tenantId,
    entityId,
    upload: { ...upload, dealId },
    uploader: { type: "staff", id: actor.userId, email: actor.userEmail ?? undefined },
    withinTransaction: async (tx, document) => {
      const { count } = await tx.dealSigner.updateMany({
        where: {
          id: signer.id, tenantId: actor.tenantId, confirmedAt: null, signedAt: null,
          OR: [{ method: null }, { method: "WET_INK", scanDocumentId: previousScan }],
        },
        data: { method: "WET_INK", scanDocumentId: document.id, scanUploadedById: actor.userId, scanUploadedAt: new Date() },
      })
      if (count !== 1) throw new SignerChangedError()
      await logAuditStrict(
        {
          tenantId: actor.tenantId,
          userId: actor.userId,
          userEmail: actor.userEmail ?? undefined,
          action: AuditAction.ASSET_DEAL_WET_INK_UPLOADED,
          entity: "DealSigner",
          entityId: signer.id,
          newValue: {
            dealId, clientId: signer.clientId, document: signer.document,
            scanDocumentId: document.id, scanSha256: document.contentSha256, replacedScanDocumentId: previousScan,
          },
        },
        tx,
      )
    },
  })
  return { kind: "done", scanDocumentId: stored.id }
}

export async function confirmWetInkScan(
  actor: SigningActor,
  dealId: string,
  signerId: string,
  reviewedScanDocumentId: string,
): Promise<ConfirmResult> {
  const signer = await findSigner(actor.tenantId, dealId, signerId)
  if (!signer) return { kind: "not_found" }
  if (signer.deal.status !== "APPROVED") return { kind: "not_open", reason: "Scans are confirmed only while the deal is APPROVED" }
  if (signerState(signer) !== "AWAITING_CONFIRMATION" || !signer.scanDocumentId) {
    return { kind: "not_open", reason: "There is no unconfirmed scan for this signer" }
  }
  if (signer.scanDocumentId !== reviewedScanDocumentId) return { kind: "scan_changed" }
  if (signer.scanUploadedById?.trim().toLowerCase() === actor.userId.trim().toLowerCase()) return { kind: "four_eyes" }

  const scanDocumentId = reviewedScanDocumentId
  const confirmed = await prisma.$transaction(async (tx) => {
    const { count } = await tx.dealSigner.updateMany({
      where: { id: signer.id, tenantId: actor.tenantId, method: "WET_INK", scanDocumentId, confirmedAt: null },
      data: { confirmedById: actor.userId, confirmedAt: new Date() },
    })
    if (count !== 1) return false
    await logAuditStrict(
      {
        tenantId: actor.tenantId,
        userId: actor.userId,
        userEmail: actor.userEmail ?? undefined,
        action: AuditAction.ASSET_DEAL_WET_INK_CONFIRMED,
        entity: "DealSigner",
        entityId: signer.id,
        newValue: { dealId, clientId: signer.clientId, document: signer.document, scanDocumentId, uploadedById: signer.scanUploadedById },
      },
      tx,
    )
    return true
  })
  return confirmed ? { kind: "done", scanDocumentId } : { kind: "not_open", reason: "The scan changed while it was being confirmed" }
}
