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

/** createdAt DESC, then id DESC in code units, as every ID-copy selection orders. */
function newestCopy<T extends IdReplacementCandidate>(copies: readonly T[]): T | null {
  return copies.reduce<T | null>((latest, document) => {
    if (latest === null) return document
    const byCreatedAt = document.createdAt.getTime() - latest.createdAt.getTime()
    if (byCreatedAt !== 0) return byCreatedAt > 0 ? document : latest
    return document.id > latest.id ? document : latest
  }, null)
}

/**
 * The ID copy a client has uploaded to replace one staff already verified, and
 * that staff have not yet reviewed; otherwise null.
 *
 * It is the newest ID copy that no named reviewer refused, and it counts only
 * while an older copy is verified (with none verified the ID is simply missing
 * or awaiting its first review, which the ordinary gap logic already reports).
 * A refused newer upload is not a replacement: the refusal is the answer, and
 * the verified copy keeps standing. Nor is a byte-identical re-upload of the
 * current verified copy (the newest verified one): the same well-formed
 * digest. A missing or malformed digest on either side never matches.
 *
 * Fail closed: while this is non-null the ID_COPY core document is outstanding,
 * so the composite KYC projection cannot stay VERIFIED on the older copy.
 * Mirrors subject_has_pending_id_replacement (migrations 20261014130000 and
 * 20261015090000).
 */
export function pendingIdReplacement<T extends IdReplacementCandidate>(
  documents: readonly T[],
): T | null {
  const idCopies = documents.filter((document) => document.docType === "ID_COPY")
  const current = newestCopy(idCopies.filter((document) => document.verified))
  if (current === null) return null

  const newest = newestCopy(idCopies.filter(
    (document) => !document.verificationRejectedById && !document.verificationRejectedAt,
  ))
  if (newest === null || newest.verified) return null

  const identicalReupload = isSha256Digest(newest.contentSha256) &&
    newest.contentSha256 === current.contentSha256
  return identicalReupload ? null : newest
}
