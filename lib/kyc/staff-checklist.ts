import {
  identicalToVerifiedIdCopy,
  outstandingCoreDocuments,
  pendingIdReplacement,
  type IdReplacementCandidate,
} from "@/lib/kyc/id-replacement"

/** A row of the staff document list (dates arrive as JSON strings). */
export interface ChecklistDocument {
  id: string
  docType: string
  verified: boolean
  createdAt: string | Date
  deletedAt?: string | Date | null
  contentSha256?: string | null
  verificationRejectedAt?: string | Date | null
  verificationRejectedById?: string | null
}

function candidates(documents: readonly ChecklistDocument[]): IdReplacementCandidate[] {
  return documents
    .filter((document) => !document.deletedAt)
    .map((document) => ({
      id: document.id,
      docType: document.docType,
      verified: document.verified,
      createdAt: new Date(document.createdAt),
      contentSha256: document.contentSha256 ?? null,
      verificationRejectedById: document.verificationRejectedById ?? null,
      verificationRejectedAt: document.verificationRejectedAt ? new Date(document.verificationRejectedAt) : null,
    }))
}

/**
 * How many of `required` the composite KYC rule counts as verified
 * (outstandingCoreDocuments: a verified copy on file, and for ID_COPY no
 * pending replacement; subject_has_composite_kyc enforces the same). So a
 * stored VERIFIED status never sits beside fewer than all of them, and an
 * identical re-upload of the verified ID copy does not lower the count.
 */
export function verifiedCoreDocumentCount(
  required: readonly string[],
  documents: readonly ChecklistDocument[],
): number {
  return required.length - outstandingCoreDocuments(required, candidates(documents)).length
}

/**
 * The ID copy holding the client PENDING (pendingIdReplacement), or null. The
 * checklist's ID row shows it, not a newer copy over it, so staff can act on
 * the copy the database is waiting for.
 */
export function pendingIdReplacementId(documents: readonly ChecklistDocument[]): string | null {
  return pendingIdReplacement(candidates(documents))?.id ?? null
}

/**
 * `document` is an ID copy that holds the newest verified copy's bytes
 * (identicalToVerifiedIdCopy), refused or not: the verify route refuses it,
 * so the checklist never offers Verify on it.
 */
export function sameBytesAsVerifiedIdCopy(
  document: ChecklistDocument,
  documents: readonly ChecklistDocument[],
): boolean {
  const idCopies = candidates(documents).filter((candidate) => candidate.docType === "ID_COPY")
  const copy = idCopies.find((candidate) => candidate.id === document.id)
  return copy !== undefined && identicalToVerifiedIdCopy(copy, idCopies)
}

/**
 * `document` is an unrefused identical re-upload of the newest verified ID
 * copy: it IS that verified copy (product decision 2026-10-16). Staff see it
 * as such, with nothing to verify or reject.
 */
export function isIdenticalToVerifiedIdCopy(
  document: ChecklistDocument,
  documents: readonly ChecklistDocument[],
): boolean {
  return !document.verificationRejectedById &&
    !document.verificationRejectedAt &&
    sameBytesAsVerifiedIdCopy(document, documents)
}
