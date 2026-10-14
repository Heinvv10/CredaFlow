/** The subset of a ClientDocument the ID-replacement rule reads. */
export interface IdReplacementCandidate {
  id: string
  docType: string
  verified: boolean
  createdAt: Date
  /** Set only when a named reviewer refused the copy. */
  verificationRejectedById?: string | null
  /** Either marker means refused: the SQL layer reads them independently. */
  verificationRejectedAt?: Date | null
}

/**
 * The ID copy a client has uploaded to replace one staff already verified, and
 * that staff have not yet reviewed; otherwise null.
 *
 * It is the newest ID copy that no named reviewer refused, and it counts only
 * while an older copy is verified (with none verified the ID is simply missing
 * or awaiting its first review, which the ordinary gap logic already reports).
 * A refused newer upload is not a replacement: the refusal is the answer, and
 * the verified copy keeps standing.
 *
 * Fail closed: while this is non-null the ID_COPY core document is outstanding,
 * so the composite KYC projection cannot stay VERIFIED on the older copy.
 * The ordering mirrors every other ID-copy selection: createdAt DESC, id DESC.
 */
export function pendingIdReplacement<T extends IdReplacementCandidate>(
  documents: readonly T[],
): T | null {
  const idCopies = documents.filter((document) => document.docType === "ID_COPY")
  if (!idCopies.some((document) => document.verified)) return null

  const newest = idCopies
    .filter((document) => !document.verificationRejectedById && !document.verificationRejectedAt)
    .reduce<T | null>((latest, document) => {
      if (latest === null) return document
      const byCreatedAt = document.createdAt.getTime() - latest.createdAt.getTime()
      if (byCreatedAt !== 0) return byCreatedAt > 0 ? document : latest
      return document.id > latest.id ? document : latest
    }, null)

  return newest !== null && !newest.verified ? newest : null
}
