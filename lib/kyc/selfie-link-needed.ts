import type { CompositeKycResult } from "@/lib/kyc/document-state"

/**
 * Whether staff still need to send the client a selfie-capture link. Not once
 * identity is covered: a passing selfie, a senior exception or an in-person
 * verification (biometricEvidence null). Offering a link then tells staff to
 * chase a selfie the client does not need.
 */
export function selfieLinkNeeded(kyc: Pick<CompositeKycResult, "biometricEvidence"> | null): boolean {
  return kyc === null || kyc.biometricEvidence !== null
}
