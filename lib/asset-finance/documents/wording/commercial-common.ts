// Shared pieces of the commercial (non-NCA) deal document wording: the clause
// shape and how a contract rate's reference is defined. DRAFT wording for the
// lender's legal team (docs/asset-finance/legal-wording/commercial.md).
import { Prisma, type ReferenceRateBasis } from "@prisma/client"
import { RATE_BASIS_LABELS } from "../../deal-labels"
import type { DealDocumentData } from "../deal-document-data"
import { percentPdf } from "../document-parts"

/** One printed clause: its heading and its text (paragraphs split on blank lines). */
export interface WordingClause {
  heading: string
  text: string
}

/** What each linked reference rate means, as data the system records (./../rates.ts, rate-feed-sync.ts). */
const REFERENCE_DEFINITIONS: Record<Exclude<ReferenceRateBasis, "FIXED">, string> = {
  PRIME: "the predominant prime overdraft rate of South African banks as published by the South African Reserve Bank",
  REPO: "the repurchase rate set by the Monetary Policy Committee of the South African Reserve Bank",
  ZARONIA:
    "the South African Rand Overnight Index Average published by the South African Reserve Bank; a change in ZARONIA is applied only when the published value differs by 0.25 percentage points or more from the value last applied",
  JIBAR: "the three-month Johannesburg Interbank Average Rate as published, or any rate that officially replaces it",
  LENDER_BASE: "the base lending rate that the Seller sets and publishes from time to time for all agreements linked to it",
}

/** "Prime plus 1.00% a year", or the fixed rate. */
export function contractRateFormula(p: DealDocumentData["pricing"]): string {
  if (p.rateBasis === "FIXED") return `${percentPdf(p.annualRate)} a year (nominal), fixed for the whole term`
  const margin = new Prisma.Decimal(p.rateMargin ?? "0")
  const sign = margin.isNegative() ? "minus" : "plus"
  return `${RATE_BASIS_LABELS[p.rateBasis]} ${sign} ${percentPdf(margin.abs().toString())} a year`
}

/** The definition of the reference a linked rate follows; null for a fixed rate. */
export function referenceDefinition(basis: ReferenceRateBasis): string | null {
  return basis === "FIXED" ? null : `"${RATE_BASIS_LABELS[basis]}" means ${REFERENCE_DEFINITIONS[basis]}.`
}

/** The parties' addresses as printed in the party sections. */
export function addressOrFallback(lines: readonly string[], fallback: string): string {
  return lines.length > 0 ? lines.join(", ") : fallback
}
