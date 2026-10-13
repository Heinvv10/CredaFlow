export const ASSET_READINESS_FIELDS = [
  "natisTitleholder",
  "trackerProvider",
  "trackerId",
  "insurer",
  "policyNumber",
] as const

export type AssetReadinessField = (typeof ASSET_READINESS_FIELDS)[number]

export function assetReadinessPatch(
  values: Record<AssetReadinessField, string>,
  lenderNotedConfirmed: boolean,
): Record<AssetReadinessField, string | null> & { lenderNotedConfirmed: boolean } {
  return {
    natisTitleholder: values.natisTitleholder.trim() || null,
    trackerProvider: values.trackerProvider.trim() || null,
    trackerId: values.trackerId.trim() || null,
    insurer: values.insurer.trim() || null,
    policyNumber: values.policyNumber.trim() || null,
    lenderNotedConfirmed,
  }
}
