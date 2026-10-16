import type { DocType } from "@prisma/client"
import { isSha256Digest } from "@/lib/documents/content-integrity"
import { isIdenticalCopy, newestCopy } from "@/lib/kyc/id-replacement"

/** The client's ID copies resolveCurrentIdDocument chooses among: every one not deleted. */
export const LIVE_ID_COPIES = {
  docType: "ID_COPY" as DocType,
  deletedAt: null,
}

/** What resolveCurrentIdDocument reads of each copy. */
export const CURRENT_ID_DOCUMENT_FIELDS = {
  id: true,
  verified: true,
  contentSha256: true,
  createdAt: true,
  verificationRejectedAt: true,
} as const

export type CurrentIdDocumentCandidate = {
  id: string
  verified: boolean
  contentSha256: string | null
  createdAt: Date
  verificationRejectedAt?: Date | null
}

/**
 * The ID copy a selfie is compared against (lib/kyc/selfie-capture.server.ts)
 * and re-checked against when its result is stored
 * (lib/kyc/selfie-biometric.server.ts), from the client's non-deleted copies:
 * the newest upload staff have not rejected, ordered createdAt DESC then id
 * DESC. Verified or not: whether the match counts is the composite gate's
 * question. Callers also require a usable digest.
 *
 * Except that an unverified identical re-upload of the newest verified copy
 * (isIdenticalCopy: the same well-formed digest) IS that verified copy, so the
 * selfie binds to the verified copy every KYC gate reads
 * (subject_has_composite_kyc, the in-person lapse rule) rather than failing
 * against its twin. A copy of other bytes, or the same bytes as an older
 * verified copy, is still the copy compared against.
 */
export function resolveCurrentIdDocument<T extends CurrentIdDocumentCandidate>(
  copies: readonly T[],
): T | null {
  const newest = newestCopy(copies.filter((copy) => (copy.verificationRejectedAt ?? null) === null))
  if (newest === null || newest.verified) return newest
  const verified = newestCopy(copies.filter((copy) => copy.verified))
  return verified !== null && isIdenticalCopy(newest, verified) ? verified : newest
}

/** The subset of a ClientDocument this selection needs. */
export type IdDocumentCandidate = {
  id: string
  docType: string
  verified: boolean
  contentSha256: string | null
  createdAt?: Date | string | null
}

/**
 * Pick the ID copy an in-person KYC verification may be recorded against.
 *
 * This MUST agree with every reader of that attestation, and there are two
 * besides this route: `readCompositeKycState` in lib/kyc/document-state.ts,
 * and the shipped Postgres function
 * `subject_has_in_person_kyc_verification`
 * (in the baseline migration).
 * Both select
 *
 *     WHERE docType = 'ID_COPY' AND deletedAt IS NULL AND verified = true
 *     ORDER BY "createdAt" DESC, "id" DESC
 *     LIMIT 1
 *
 * and validate the digest of THAT row. So the newest verified copy is the
 * subject, full stop — a writer that picked any other row could record an
 * attestation the database then refuses to honour at payout, which is worse
 * than refusing to record it at all.
 *
 * What this fixes is narrower and real: the original took
 * `coreDocuments.find((d) => d.docType === "ID_COPY")` over a `findMany` with
 * NO `orderBy`, so it took whichever row Postgres returned first — in practice
 * the OLDEST. A client whose first upload predates content hashing was refused
 * "a verified ID document with intact stored content is required" while a
 * newer, perfectly good copy was the one every reader would have used.
 *
 * Returns null when the newest verified copy has no usable digest — which is
 * exactly the state the caller's error message describes, and exactly what the
 * database would enforce anyway.
 */
export function selectUsableIdDocument<T extends IdDocumentCandidate>(
  documents: readonly T[],
): (T & { contentSha256: string }) | null {
  const verified = documents.filter((d) => d.docType === "ID_COPY" && d.verified)
  if (verified.length === 0) return null

  // Same ordering as the readers: createdAt DESC, then id DESC as the
  // tiebreak, so two rows written in the same millisecond resolve identically
  // here and in Postgres.
  const newest = [...verified].sort(
    (a, b) => time(b.createdAt) - time(a.createdAt) || String(b.id).localeCompare(String(a.id)),
  )[0]

  return isSha256Digest(newest.contentSha256)
    ? (newest as T & { contentSha256: string })
    : null
}

function time(value: Date | string | null | undefined): number {
  if (!value) return 0
  const t = new Date(value).getTime()
  return Number.isNaN(t) ? 0 : t
}
