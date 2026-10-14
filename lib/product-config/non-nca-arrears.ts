// The NON_NCA (asset finance) arrears terms of a loan product, as the
// loan-product API receives them (decision 2a.4 of the slice-1 goal):
//   nonNcaDefaultInterestMargin — annual decimal over the contract rate on
//     overdue amounts ("0.02" = 2%), at most 6 places (DECIMAL(9,6));
//   nonNcaCollectionFeeCents — whole cents per missed instalment.
// Each is optional: absent leaves the stored value unchanged, null clears it.
// Both are >= 0 (CHECK LoanProduct_non_nca_arrears_terms). The margin must be
// below 1 (100% a year): a sanity bound that catches a percentage sent where
// the decimal belongs ("2" for 2%), not a policy cap. Never applied to an NCA
// loan (lib/loan/charges-replay.ts).

import { INT4_MAX } from "./bounds"

export interface NonNcaArrearsTerms {
  nonNcaDefaultInterestMargin?: string | null
  nonNcaCollectionFeeCents?: number | null
}

const MARGIN = /^0(\.\d{1,6})?$/

export function parseNonNcaArrearsTerms(body: Record<string, unknown>): { data: NonNcaArrearsTerms } | { issues: string[] } {
  const data: NonNcaArrearsTerms = {}
  const issues: string[] = []
  if ("nonNcaDefaultInterestMargin" in body) {
    const raw = body.nonNcaDefaultInterestMargin
    const text = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw
    if (raw === null) data.nonNcaDefaultInterestMargin = null
    else if (typeof text === "string" && MARGIN.test(text.trim())) data.nonNcaDefaultInterestMargin = text.trim()
    else issues.push("nonNcaDefaultInterestMargin")
  }
  if ("nonNcaCollectionFeeCents" in body) {
    const raw = body.nonNcaCollectionFeeCents
    if (raw === null) data.nonNcaCollectionFeeCents = null
    else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= INT4_MAX) data.nonNcaCollectionFeeCents = raw
    else issues.push("nonNcaCollectionFeeCents")
  }
  return issues.length > 0 ? { issues } : { data }
}

/** The audit shape of the stored terms (the margin as its decimal string). */
export function nonNcaArrearsAudit(row: { nonNcaDefaultInterestMargin: { toString(): string } | null; nonNcaCollectionFeeCents: number | null }) {
  return {
    nonNcaDefaultInterestMargin: row.nonNcaDefaultInterestMargin?.toString() ?? null,
    nonNcaCollectionFeeCents: row.nonNcaCollectionFeeCents,
  }
}
