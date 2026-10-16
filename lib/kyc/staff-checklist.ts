import {
  isIdenticalCopy,
  newestCopy,
  outstandingCoreDocuments,
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
 * `document` is an unverified, unrefused ID copy created after the newest
 * verified one with the same well-formed digest (isIdenticalCopy): it IS that
 * verified copy (product decision 2026-10-16). Staff see it as such, with
 * nothing to verify or reject.
 */
export function isIdenticalToVerifiedIdCopy(
  document: ChecklistDocument,
  documents: readonly ChecklistDocument[],
): boolean {
  const live = candidates(documents)
  const copy = live.find((candidate) => candidate.id === document.id)
  if (!copy || copy.docType !== "ID_COPY" || copy.verified) return false
  if (copy.verificationRejectedById || copy.verificationRejectedAt) return false
  const current = newestCopy(live.filter((candidate) => candidate.docType === "ID_COPY" && candidate.verified))
  return current !== null && newestCopy([current, copy]) === copy && isIdenticalCopy(copy, current)
}
