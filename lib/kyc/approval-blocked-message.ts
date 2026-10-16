import type { KycOverrideMinRole } from "@/lib/kyc/override-policy"

const ROLE_LABEL: Record<KycOverrideMinRole, string> = {
  ADMIN: "an Admin",
  BRANCH_MANAGER: "a Branch Manager or Admin",
}

/**
 * Why KYC cannot be approved yet, in words a credit officer can act on: what
 * is missing, who may record the alternative, and where. The lender's KYC
 * override policy says who (Settings → Security & KYC policy); off, there is
 * no alternative to a passing selfie.
 */
export function kycApprovalBlockedMessage(policy: { enabled: boolean; minRole: KycOverrideMinRole }): string {
  const base = "KYC can't be approved yet. All four core documents must be verified, and the client's identity confirmed by a selfie that passed."
  if (!policy.enabled) return `${base} Ask the client for a new selfie.`
  const who = ROLE_LABEL[policy.minRole]
  return `${base} If no selfie can be taken, ${who} can verify the client in person instead; if a selfie was taken and failed, ${who} can record a reasoned exception. Both are on this client's KYC tab.`
}
