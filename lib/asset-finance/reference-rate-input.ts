/**
 * Validation of a staff-recorded reference rate (POST
 * /api/asset-finance/reference-rates). A reference rate is an annual nominal
 * decimal with at most 6 places (the column is DECIMAL(9,6)) inside the sanity
 * band: above 0 and below 0.5 (50%), the same band as CHECK
 * ReferenceRate_rate_band; FIXED is a contract basis, never a reference.
 */
import type { ReferenceRateBasis } from "@prisma/client"
import { toDayNumber } from "./dates"

export const REFERENCE_BASES = ["PRIME", "REPO", "JIBAR", "ZARONIA", "LENDER_BASE"] as const satisfies readonly ReferenceRateBasis[]

export interface ReferenceRateInput {
  basis: (typeof REFERENCE_BASES)[number]
  effectiveDate: string // YYYY-MM-DD
  rate: string // decimal string, e.g. "0.1175"
}

const RATE = /^0(\.\d{1,6})?$/
/** The sanity band, both ends excluded (CHECK ReferenceRate_rate_band). */
export const REFERENCE_RATE_BAND = { above: 0, below: 0.5 } as const

/** The SARB repo rate as an annual decimal: 1%–20% is the plausible band. */
export const REPO_RATE_PLAUSIBLE = { min: 0.01, max: 0.2 } as const
export const repoRateIsPlausible = (rate: number) => rate >= REPO_RATE_PLAUSIBLE.min && rate <= REPO_RATE_PLAUSIBLE.max

export function parseReferenceRateInput(body: unknown): ReferenceRateInput | { errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {}

  const basis = REFERENCE_BASES.find((candidate) => candidate === record.basis)
  if (!basis) errors.basis = `must be one of ${REFERENCE_BASES.join(", ")}`

  const effectiveDate = typeof record.effectiveDate === "string" ? record.effectiveDate : ""
  try {
    toDayNumber(effectiveDate, "effectiveDate")
  } catch {
    errors.effectiveDate = "must be a calendar date YYYY-MM-DD"
  }

  const rate = typeof record.rate === "string" || typeof record.rate === "number" ? String(record.rate) : ""
  if (!RATE.test(rate) || !(Number(rate) > REFERENCE_RATE_BAND.above && Number(rate) < REFERENCE_RATE_BAND.below)) {
    errors.rate = "must be an annual decimal above 0 and below 0.5 with at most 6 places, e.g. 0.1175"
  }

  // The repo rate sets the NCA interest-rate cap (lib/loan/nca-interest-cap.ts):
  // a value outside the plausible band is a typo, never a rate.
  if (basis === "REPO" && !errors.rate && !repoRateIsPlausible(Number(rate))) {
    errors.rate = `a repo rate must be between ${REPO_RATE_PLAUSIBLE.min * 100}% and ${REPO_RATE_PLAUSIBLE.max * 100}%`
  }

  if (!basis || Object.keys(errors).length > 0) return { errors }
  return { basis, effectiveDate, rate }
}
