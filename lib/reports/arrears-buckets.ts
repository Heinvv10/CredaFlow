/**
 * Arrears ageing bands — ONE definition, used by the reports overview, the
 * board pack, the arrears-aging report and the PAR spreadsheet export.
 *
 * The boundary that matters is 90. PAR90 and NPL are `>= 90` everywhere in this
 * product, so a loan at exactly 90 days past due belongs in the 90+ band. Three
 * of the four surfaces bucketed it as `days <= 90 → "61-90 DPD"` and started
 * "90+" at 91, so the bucket table and the NPL headline disagreed at the
 * boundary by exactly the loans sitting on day 90 — and the reports overview
 * queried `gte: 61, lte: 89` while labelling the result "61-90 DPD", claiming
 * to include a day it excluded.
 *
 * Bands are contiguous and exhaustive over `days >= 1`.
 */

export type ArrearsBucketLabel = "1-30 DPD" | "31-60 DPD" | "61-89 DPD" | "90+ DPD"

export type ArrearsBand = {
  label: ArrearsBucketLabel
  /** Inclusive lower bound in days past due. */
  min: number
  /** Inclusive upper bound; null for the open-ended 90+ band. */
  max: number | null
}

export const ARREARS_BANDS: ArrearsBand[] = [
  { label: "1-30 DPD", min: 1, max: 30 },
  { label: "31-60 DPD", min: 31, max: 60 },
  { label: "61-89 DPD", min: 61, max: 89 },
  { label: "90+ DPD", min: 90, max: null },
]

/** The band a given days-past-due value falls in. */
export function arrearsBucket(days: number): ArrearsBucketLabel {
  for (const band of ARREARS_BANDS) {
    if (days >= band.min && (band.max === null || days <= band.max)) return band.label
  }
  // days < 1 is not in arrears at all; callers filter on `daysInArrears > 0`
  // before bucketing, so this is a floor rather than a real case.
  return ARREARS_BANDS[0].label
}
