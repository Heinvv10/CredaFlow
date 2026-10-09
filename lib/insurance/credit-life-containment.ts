import { creditLifePrincipalIsEligible } from "./credit-life-election"

type CreditLifeAutoBundleEnv = {
  [key: string]: string | undefined
  CREDIT_LIFE_AUTO_BUNDLE_ENABLED?: string
}

export type CreditLifeAutoBundleDecision =
  | { eligible: true }
  | { eligible: false; reason: "feature_disabled" | "below_threshold" }

/**
 * Interim compliance containment. Auto-bundling is opt-in until the customer
 * insurance election and exact premium are captured before the PASQ is
 * generated and acknowledged. Missing or malformed configuration fails safe.
 */
export function isCreditLifeAutoBundleEnabled(
  env: CreditLifeAutoBundleEnv = process.env,
): boolean {
  return env.CREDIT_LIFE_AUTO_BUNDLE_ENABLED === "true"
}

export function creditLifeAutoBundleDecision(
  principalCents: number,
  env: CreditLifeAutoBundleEnv = process.env,
): CreditLifeAutoBundleDecision {
  if (!isCreditLifeAutoBundleEnabled(env)) {
    return { eligible: false, reason: "feature_disabled" }
  }
  if (!creditLifePrincipalIsEligible(principalCents)) {
    return { eligible: false, reason: "below_threshold" }
  }
  return { eligible: true }
}

/**
 * Only a decision captured in the exact agreement artifact authorises the
 * later disbursement transaction to auto-create a policy. Missing/legacy or
 * malformed artifact data fails safe so an environment toggle after signing
 * cannot introduce cover the customer never saw. Once the artifact opts in,
 * that signed commitment remains authoritative even if the live flag changes.
 */
export type CreditLifeAgreementElection =
  | { resolved: true; eligible: boolean }
  | { resolved: false }

export function creditLifeAutoBundleElection(
  artifactData: unknown,
): CreditLifeAgreementElection {
  if (
    !artifactData
    || typeof artifactData !== "object"
    || Array.isArray(artifactData)
    || typeof (artifactData as Record<string, unknown>).creditLifeAutoBundleEligible !== "boolean"
  ) {
    return { resolved: false }
  }

  return {
    resolved: true,
    eligible: (artifactData as Record<string, unknown>).creditLifeAutoBundleEligible as boolean,
  }
}
