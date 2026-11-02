import { createHash } from "node:crypto"
import { readAffordabilitySnapshotStore } from "@/lib/affordability/snapshot"
import { normaliseEmail, toWaJid } from "@/lib/contact/identity"
import { biometricSubjectFingerprint, type BiometricSubjectClient } from "@/lib/kyc/biometric-evidence"

/** The borrower as an approval freezes them: the person, and where their one-time signing code goes. */
export type FrozenBorrower = BiometricSubjectClient & { email?: string | null; whatsapp?: string | null }

const frozenBorrower = (client: FrozenBorrower) => createHash("sha256")
  .update([biometricSubjectFingerprint(client), client.email ? normaliseEmail(client.email) : "", client.whatsapp ? toWaJid(client.whatsapp) : ""].join(":"), "utf8")
  .digest("hex")

/**
 * The borrower's identity, frozen with a key-facts approval. An NCA approval binds it through the bureau check; a key-facts one has
 * none, so without this a client record renamed after signing would be paid on an agreement made with someone else. It goes in the
 * approval's inputs (`borrowerIdentity`): decide stamps it, the fingerprint covers it, and every later check rebuilds it from the live
 * client, so a change reads as any other change after approval. An NCA application adds nothing: its fingerprints do not move.
 * The email and WhatsApp number are in it because the signing code goes there: staff who may also witness a signature could otherwise
 * point the borrower's own code at themselves. A change refuses until the application returns to review and is approved again.
 */
export function frozenIdentityInput(application: { disclosureRegime?: string | null; client: FrozenBorrower }): { borrowerIdentity?: string } {
  return application.disclosureRegime === "KEY_FACTS" ? { borrowerIdentity: frozenBorrower(application.client) } : {}
}

/** Whether the client is no longer the person the approval assessed. The gate before the documents are rendered with their name. */
export function identityChangedSinceApproval(application: { affordabilityResult: unknown; client: FrozenBorrower }): boolean {
  return readAffordabilitySnapshotStore(application.affordabilityResult).approval?.inputs.borrowerIdentity !== frozenBorrower(application.client)
}
