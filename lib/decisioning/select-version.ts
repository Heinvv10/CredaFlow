import { createHash } from "node:crypto"

export interface VersionRef {
  id: string
  /** The product id, or "ALL". */
  scopeKey: string
  version: number
  /** SAST calendar day, YYYY-MM-DD. */
  effectiveFrom: string
  challengerOnly: boolean
}

/**
 * The version that decides as champion for a product on a SAST day: the
 * highest effective version of the product's own set, else of the lender-wide
 * set. A challenger-only version is never champion; none effective: null.
 */
export function pickChampion<T extends VersionRef>(versions: readonly T[], productId: string, today: string): T | null {
  const effective = versions.filter((v) => !v.challengerOnly && v.effectiveFrom <= today)
  for (const scope of [productId, "ALL"]) {
    const best = effective.filter((v) => v.scopeKey === scope).sort((a, b) => b.version - a.version)[0]
    if (best) return best
  }
  return null
}

/**
 * Whether an application is in the challenger's share: a stable hash of the
 * application and the challenger version, so the same application is always
 * on the same side, and raising the percent only adds applications.
 */
export function inChallengerGroup(applicationId: string, challengerVersionId: string, percent: number): boolean {
  if (percent <= 0) return false
  const digest = createHash("sha256").update(`${applicationId}:${challengerVersionId}`).digest()
  return digest.readUInt32BE(0) % 100 < percent
}
