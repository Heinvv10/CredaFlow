import { isSha256Digest } from "@/lib/documents/content-integrity"

/** The subset of a ClientDocument the ID-replacement rule reads. */
export interface IdReplacementCandidate {
  id: string
  docType: string
  verified: boolean
  createdAt: Date
  /**
   * Digest of the stored bytes. Null or absent (a read that did not select it)
   * never matches, so the copy stays a pending replacement: fail closed.
   */
  contentSha256?: string | null
  /** Set only when a named reviewer refused the copy. */
  verificationRejectedById?: string | null
  /** Either marker means refused: the SQL layer reads them independently. */
  verificationRejectedAt?: Date | null
}

/**
 * The required document types a writer of VERIFIED must still refuse on: those
 * with no verified copy, plus ID_COPY while a replacement awaits review (the
 * database refuses VERIFIED then too: subject_has_pending_id_replacement).
 */
export function outstandingCoreDocuments<D extends string>(
  required: readonly D[],
  documents: readonly IdReplacementCandidate[],
): D[] {
  const verified = new Set(
    documents.filter((document) => document.verified).map((document) => document.docType),
  )
  const replacementPending = pendingIdReplacement(documents) !== null
  return required.filter(
    (docType) => !verified.has(docType) || (docType === "ID_COPY" && replacementPending),
  )
}

/** An ID copy as the ordering reads it. */
type OrderedCopy = { id: string; createdAt: Date }

/**
 * `a` sorts before `b` in createdAt DESC, id DESC order: created after it.
 * Ids tie-break in UTF-16 code units; SQL compares COLLATE "C" (UTF-8 bytes).
 * Those differ only for ids outside the BMP, which cuids never contain.
 */
function createdAfter(a: OrderedCopy, b: OrderedCopy): boolean {
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime()
  return byCreatedAt !== 0 ? byCreatedAt > 0 : a.id > b.id
}

/** createdAt DESC, then id DESC, as every ID-copy selection orders. */
export function newestCopy<T extends OrderedCopy>(copies: readonly T[]): T | null {
  return copies.reduce<T | null>(
    (latest, document) => (latest === null || createdAfter(document, latest) ? document : latest),
    null,
  )
}

/**
 * The ID copy a client has uploaded to replace the one staff verified, and
 * that staff have not yet reviewed; otherwise null.
 *
 * The current verified copy is the newest verified one. Every copy created
 * after it that is unverified and that no reviewer refused holds the client,
 * unless it is a byte-identical re-upload of that current copy (the same
 * well-formed digest; a missing or malformed digest never matches). A newer
 * identical copy does not hide an older different one. With no verified copy
 * there is nothing to replace: the ordinary gap logic reports a first review.
 * Returns the newest copy that holds.
 *
 * Fail closed: while this is non-null the ID_COPY core document is outstanding,
 * so the composite KYC projection cannot stay VERIFIED on the older copy.
 * Mirrors subject_has_pending_id_replacement (migrations 20261014130000 and
 * 20261015130000).
 */
export function pendingIdReplacement<T extends IdReplacementCandidate>(
  documents: readonly T[],
): T | null {
  const idCopies = documents.filter((document) => document.docType === "ID_COPY")
  const current = newestCopy(idCopies.filter((document) => document.verified))
  if (current === null) return null

  return newestCopy(idCopies.filter((document) =>
    !document.verified &&
    !document.verificationRejectedById &&
    !document.verificationRejectedAt &&
    createdAfter(document, current) &&
    !isIdenticalCopy(document, current)))
}

/**
 * `document` is an unverified ID copy created after the newest verified one
 * among `copies` (the client's live ID copies), holding its bytes
 * (isIdenticalCopy): it IS that verified copy. Verifying it would only move
 * the evidence a selfie or an in-person attestation is bound to, so the verify
 * route refuses it, refused or not, and the staff checklist offers no Verify.
 */
export function identicalToVerifiedIdCopy(
  document: OrderedCopy & { verified: boolean; contentSha256?: string | null },
  copies: readonly (OrderedCopy & { verified: boolean; contentSha256?: string | null })[],
): boolean {
  const current = newestCopy(copies.filter((copy) => copy.verified))
  return current !== null && !document.verified && createdAfter(document, current) && isIdenticalCopy(document, current)
}

/**
 * `copy` holds the same bytes as `current`: a well-formed digest equal to
 * its. A missing or malformed digest never matches (fail closed). An identical
 * re-upload of the current verified copy IS that copy: it is no pending
 * replacement, and a selfie binds to the verified copy, not to it
 * (resolveCurrentIdDocument in lib/kyc/usable-id-document.ts).
 */
export function isIdenticalCopy(
  copy: { contentSha256?: string | null },
  current: { contentSha256?: string | null },
): boolean {
  return isSha256Digest(copy.contentSha256) && copy.contentSha256 === current.contentSha256
}
