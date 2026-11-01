import { readAffordabilitySnapshotStore } from "@/lib/affordability/snapshot"
import { biometricSubjectFingerprint, type BiometricSubjectClient } from "@/lib/kyc/biometric-evidence"

/**
 * The borrower's identity, frozen with a key-facts approval. An NCA approval binds it through the bureau check; a key-facts one has
 * none, so without this a client record renamed after signing would be paid on an agreement made with someone else. It goes in the
 * approval's inputs (`borrowerIdentity`): decide stamps it, the fingerprint covers it, and every later check rebuilds it from the live
 * client, so a change reads as any other change after approval. An NCA application adds nothing: its fingerprints do not move.
 */
export function frozenIdentityInput(application: { disclosureRegime?: string | null; client: BiometricSubjectClient }): { borrowerIdentity?: string } {
  return application.disclosureRegime === "KEY_FACTS" ? { borrowerIdentity: biometricSubjectFingerprint(application.client) } : {}
}

/** Whether the client is no longer the person the approval assessed. The gate before the documents are rendered with their name. */
export function identityChangedSinceApproval(application: { affordabilityResult: unknown; client: BiometricSubjectClient }): boolean {
  return readAffordabilitySnapshotStore(application.affordabilityResult).approval?.inputs.borrowerIdentity !== biometricSubjectFingerprint(application.client)
}
