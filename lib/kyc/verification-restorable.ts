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
 */
export function verificationRestorable(
  storedKycStatus: string,
  composite: Pick<CompositeKycResult, "state">,
): boolean {
  return storedKycStatus === "PENDING" && composite.state.kycStatus === "VERIFIED"
}
