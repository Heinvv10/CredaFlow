import { randomUUID } from "node:crypto"
import type { DocType } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { deleteFile, saveFile } from "@/lib/storage"
import { matchesMagic, MAGIC_BYTE_PREFIX } from "@/lib/document-auth"
import { AuditAction } from "@/lib/audit"
import { clientKycAuditValue } from "@/lib/kyc/document-state"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { runBiometricVerification } from "@/lib/kyc/selfie-biometric.server"

const MAX_SELFIE_SIZE = 5 * 1024 * 1024

/**
 * Who supplied the bytes. Carried explicitly rather than as a bare user id
 * because `ClientDocument.uploadedByType` distinguishes the two, and a consumer
 * arriving on a capture link is a `client` upload with no session — not a staff
 * one, and not a new third kind.
 */
export type SelfieUploader =
  | { type: "staff"; userId: string }
  | { type: "client"; clientId: string; email: string | null }

export interface CaptureSelfieArgs {
  tenantId: string
  /**
   * Null only for a staff upload that omitted it. Nullable rather than
   * validated by the caller so the "clientId is required" refusal keeps its
   * ORIGINAL position — after the image checks, not before them. Hoisting it
   * into the route changed which error a request with two faults received.
   */
  clientId: string | null
  image: File | null
  uploader: SelfieUploader
}

export type CaptureSelfieResult =
  | { ok: true; documentId: string; document: Record<string, unknown> }
  | { ok: false; status: number; error: string }

function sanitiseDoc(doc: Record<string, unknown>) {
  const { storagePath: _sp, ...safe } = doc
  return safe
}

/**
 * Store a selfie, open a biometric attempt against it, and kick off the VLM
 * face match.
 *
 * Extracted VERBATIM from app/api/documents/selfie/route.ts so that the
 * authenticated staff/portal route and the consumer capture-link route run the
 * SAME pipeline — same size and MIME checks, same magic-byte check, same
 * evidence lock, same ClientDocument row, same audit rows, same async match.
 * Duplicating it would guarantee divergence, and divergence here is a
 * disbursement bug.
 *
 * This function deliberately does NOT authenticate. Its callers do: the staff
 * route via `getDocumentCaller`, the link route by resolving a one-time token.
 */
export async function captureSelfie(args: CaptureSelfieArgs): Promise<CaptureSelfieResult> {
  const { tenantId, image, uploader } = args

  let uncommittedStoragePath: string | null = null
  const discardUncommittedSelfie = async () => {
    const storagePath = uncommittedStoragePath
    uncommittedStoragePath = null
    if (!storagePath) return
    await deleteFile(storagePath).catch((cleanupError) => {
      console.error("Failed to remove unclaimed selfie file:", cleanupError)
    })
  }

  try {
    if (!image) {
      return { ok: false, status: 400, error: "image is required" }
    }

    if (!image.type.startsWith("image/jpeg") && !image.type.startsWith("image/png")) {
      return { ok: false, status: 400, error: "Only JPEG/PNG images are accepted for selfies" }
    }

    if (image.size > MAX_SELFIE_SIZE) {
      return { ok: false, status: 400, error: "Selfie too large. Maximum 5MB" }
    }

    // Verify the real content matches the declared MIME (defence vs. a spoofed
    // Content-Type). Selfies are JPEG/PNG only (audit F-5).
    const head = new Uint8Array(await image.slice(0, MAGIC_BYTE_PREFIX).arrayBuffer())
    if (!matchesMagic(head, image.type)) {
      return { ok: false, status: 400, error: "File content does not match its type" }
    }

    // Position matters: the original handler resolved the client AFTER every
    // image check, so a staff request missing both an image and a clientId was
    // told about the image first. Keep that order.
    const clientId = args.clientId
    if (!clientId) {
      return { ok: false, status: 400, error: "clientId is required for staff uploads" }
    }

    // A selfie needs an ID document on file, but must not depend on AI extraction.
    // A deployment can run with VLM disabled and staff can review/verify the ID manually.
    const idDoc = await prisma.clientDocument.findFirst({
      where: { tenantId, clientId, docType: "ID_COPY" as DocType, deletedAt: null },
      orderBy: { createdAt: "desc" },
    })
    if (!idDoc) {
      return {
        ok: false,
        status: 422,
        error: "Please upload your ID document before taking a selfie.",
      }
    }

    const buffer = Buffer.from(await image.arrayBuffer())
    const { storagePath, fileSize } = await saveFile(buffer, image.type)
    uncommittedStoragePath = storagePath
    const contentSha256 = sha256DocumentBytes(buffer)
    const extractionGeneration = randomUUID()
    const extractionStartedAt = new Date()
    const outcome = await prisma.$transaction(async (tx) => {
      await lockAffordabilityClientEvidence(tx, { tenantId, clientId })

      // Re-check after taking the same evidence lock as deletion and payout.
      // The optimistic read above avoids storing a file in the common error
      // case; this read closes the ID-delete/upload race.
      const currentIdDocument = await tx.clientDocument.findFirst({
        where: {
          tenantId,
          clientId,
          docType: "ID_COPY" as DocType,
          deletedAt: null,
        },
        select: { id: true, storagePath: true, mimeType: true, contentSha256: true },
        orderBy: { createdAt: "desc" },
      })
      if (!currentIdDocument) return null

      const clientBeforeAttempt = await tx.client.findUnique({
        where: { id: clientId, tenantId },
        select: {
          kycStatus: true,
          kycVerifiedAt: true,
          kycVerifiedById: true,
          kycVerificationMethod: true,
          kycManualRejectionActive: true,
          kycManualRejectionAt: true,
          kycManualRejectionById: true,
          kycManualRejectionReason: true,
          kycManualRejectionResolvedAt: true,
          kycManualRejectionResolvedById: true,
          kycManualRejectionResolutionReason: true,
        },
      })
      if (!clientBeforeAttempt) return null

      const mustReopenKyc = !clientBeforeAttempt.kycManualRejectionActive && (
        clientBeforeAttempt.kycStatus !== "PENDING" ||
        clientBeforeAttempt.kycVerifiedAt !== null ||
        clientBeforeAttempt.kycVerifiedById !== null ||
        clientBeforeAttempt.kycVerificationMethod !== null
      )
      const clientForAttempt = mustReopenKyc
        ? await tx.client.update({
            where: { id: clientId, tenantId },
            data: {
              kycStatus: "PENDING",
              kycVerifiedAt: null,
              kycVerifiedById: null,
              kycVerificationMethod: null,
            },
            select: {
              kycStatus: true,
              kycVerifiedAt: true,
              kycVerifiedById: true,
              kycVerificationMethod: true,
              kycManualRejectionActive: true,
              kycManualRejectionAt: true,
              kycManualRejectionById: true,
              kycManualRejectionReason: true,
              kycManualRejectionResolvedAt: true,
              kycManualRejectionResolvedById: true,
              kycManualRejectionResolutionReason: true,
            },
          })
        : clientBeforeAttempt

      const created = await tx.clientDocument.create({
        data: {
          tenantId,
          clientId,
          docType: "SELFIE" as DocType,
          fileUrl: "",
          fileName: image.name || "selfie.jpg",
          mimeType: image.type,
          fileSize,
          storagePath,
          contentSha256,
          uploadedByType: uploader.type,
          uploadedById: uploader.type === "staff" ? uploader.userId : uploader.clientId,
          extractionStatus: "processing",
          extractionGeneration,
          extractionStartedAt,
        },
      } as never) as unknown as { id: string } & Record<string, unknown>

      await tx.auditLog.create({
        data: {
          tenantId,
          userId: uploader.type === "staff" ? uploader.userId : null,
          userEmail: uploader.type === "client" ? uploader.email : null,
          action: AuditAction.DOCUMENT_UPLOADED,
          entity: "ClientDocument",
          entityId: created.id,
          oldValue: {
            clientKyc: {
              ...clientKycAuditValue(clientBeforeAttempt),
              kycVerifiedById: clientBeforeAttempt.kycVerifiedById,
            },
          },
          newValue: {
            docType: "SELFIE",
            extractionStatus: "processing",
            extractionGeneration,
            extractionStartedAt: extractionStartedAt.toISOString(),
            idDocumentId: currentIdDocument.id,
            biometricAttempt: {
              reason: "new_biometric_attempt",
              clientKyc: {
                ...clientKycAuditValue(clientForAttempt),
                kycVerifiedById: clientForAttempt.kycVerifiedById,
              },
            },
          },
        },
      })

      return { created, idDocument: currentIdDocument }
    })
    if (!outcome) {
      await discardUncommittedSelfie()
      return {
        ok: false,
        status: 422,
        error: "Please upload your ID document before taking a selfie.",
      }
    }
    const doc = outcome.created
    // The database now owns the storage reference. Only failures before this
    // point may delete the bytes; later biometric processing retains them as
    // the auditable attempt record.
    uncommittedStoragePath = null

    // Fire-and-forget: VLM liveness + face match against the ID photograph
    runBiometricVerification(
      doc.id,
      clientId,
      tenantId,
      extractionGeneration,
      buffer,
      image.type,
      outcome.idDocument,
    ).catch((err) => {
      console.error("Biometric verification chain failed:", err)
    })

    return {
      ok: true,
      documentId: doc.id,
      document: sanitiseDoc(doc as unknown as Record<string, unknown>),
    }
  } catch (error) {
    await discardUncommittedSelfie()
    console.error("Selfie upload failed:", error)
    return { ok: false, status: 500, error: "Failed to upload selfie" }
  }
}
