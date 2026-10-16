import type { CompositeKycResult } from "@/lib/kyc/document-state"

/** Staff-facing hint, shown on the client KYC tab when verificationRestorable holds. */
export const VERIFICATION_RESTORABLE_COPY =
  "The evidence on file supports VERIFIED again, for example after a replacement ID was withdrawn. Re-verify to restore VERIFIED."

/**
 * The stored status is PENDING while the composite evidence derives VERIFIED,
 * which implies no replacement ID is pending and no manual rejection is active.
 * It happens when a client deletes the replacement ID they uploaded: the delete
 * only ever lowers the stored status (app/api/documents/[id]/route.ts), so the
 * client stays PENDING on evidence that would verify. Nothing promotes it
 * automatically; this only tells staff a verification would succeed.
 *
 * Not while a staff member's deliberate manual PENDING is the latest status
 * change (manualPendingStands, lib/kyc/manual-pending.server.ts): staff chose
 * PENDING on that evidence, and a re-derive would quietly undo the decision.
 */
export function verificationRestorable(
  storedKycStatus: string,
  composite: Pick<CompositeKycResult, "state">,
  history: { manualPendingStands: boolean },
): boolean {
  return storedKycStatus === "PENDING" &&
    composite.state.kycStatus === "VERIFIED" &&
    !history.manualPendingStands
}

/** A row of the staff document list (dates arrive as JSON strings). */
export interface ListedIdCopyCandidate {
  id: string
  docType: string
  verified: boolean
  deletedAt?: string | Date | null
  createdAt: string | Date
}

/**
 * The ID copy "Re-verify ID" verifies: the newest verified, non-deleted one,
 * createdAt DESC then id DESC in code units, the copy the composite rule and
 * subject_has_composite_kyc rest on.
 */
export function newestVerifiedIdCopyId(documents: readonly ListedIdCopyCandidate[]): string | null {
  let newest: { id: string; at: number } | null = null
  for (const document of documents) {
    if (document.docType !== "ID_COPY" || !document.verified || document.deletedAt) continue
    const at = new Date(document.createdAt).getTime()
    if (newest === null || at > newest.at || (at === newest.at && document.id > newest.id)) {
      newest = { id: document.id, at }
    }
  }
  return newest?.id ?? null
}
