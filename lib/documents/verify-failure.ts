// The document-verify endpoint explains every refusal — immutable artefact,
// invalid biometric evidence (with a machine reason), not found. Rendering a
// generic "Could not verify document." discards that and turns a diagnosable
// refusal into a support call. This is the single place the failure body is
// turned into operator-facing text.
import { biometricFailureCopy } from "@/lib/kyc/biometric-failure-copy"

export function documentActionFailureMessage(
  body: unknown,
  fallback: string,
): string {
  if (typeof body !== "object" || body === null) return fallback
  const record = body as Record<string, unknown>
  const error = typeof record.error === "string" && record.error.trim() !== ""
    ? record.error.trim()
    : fallback
  const machineReason = record.biometricEvidence
  if (typeof machineReason !== "string" || machineReason.trim() === "") return error
  // The enum is an internal identifier, not English. Appending it made sense
  // while the server sent one generic sentence for every biometric refusal —
  // it was the only thing distinguishing them. Now that the server sends the
  // real wording, "(reason: subject_identity_changed)" adds nothing a staff
  // member can use and reintroduces exactly the internal vocabulary
  // BIOMETRIC_FAILURE_COPY exists to keep out of the UI.
  //
  // A reason with no copy still gets it: there, the identifier is the only
  // information available and a support call needs something to quote. It
  // stays in the response body either way, for logs and machine consumers.
  return biometricFailureCopy(machineReason.trim())
    ? error
    : `${error} (reason: ${machineReason.trim()})`
}
