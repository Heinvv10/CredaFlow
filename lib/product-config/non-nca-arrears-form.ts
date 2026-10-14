// The loan-product form's NON_NCA arrears terms as typed (margin in % a year,
// fee in rand) and their conversion to and from the API fields
// (./non-nca-arrears.ts). Plain functions, so the server page and the client
// form both import them.
import { percentToDecimal } from "@/lib/asset-finance/deal-labels"
import { randsToCents } from "@/lib/asset-finance/money-input"

/** The two NON_NCA arrears terms as typed: the margin in % a year, the fee in rand. Empty = none. */
export interface NonNcaArrearsValues {
  marginPercent: string
  feeRand: string
}

/** The stored terms (annual decimal string, cents) as the form shows them. */
export function nonNcaArrearsValues(margin: string | null, feeCents: number | null): NonNcaArrearsValues {
  return {
    marginPercent: margin === null ? "" : String(Number((Number(margin) * 100).toFixed(4))),
    feeRand: feeCents === null ? "" : (feeCents / 100).toFixed(2),
  }
}

/** The API fields (lib/product-config/non-nca-arrears.ts), or why the typed values are not valid. */
export function nonNcaArrearsBody(values: NonNcaArrearsValues):
  | { body: { nonNcaDefaultInterestMargin: string | null; nonNcaCollectionFeeCents: number | null } }
  | { error: string } {
  const margin = values.marginPercent.trim() === "" ? null : percentToDecimal(values.marginPercent, false)
  if (margin === null && values.marginPercent.trim() !== "") return { error: "Default-interest margin: enter a percentage a year, e.g. 2 or 2.5" }
  const fee = values.feeRand.trim() === "" ? null : randsToCents(values.feeRand)
  if (fee === null && values.feeRand.trim() !== "") return { error: "Collection fee: enter an amount in rand, e.g. 250" }
  return { body: { nonNcaDefaultInterestMargin: margin, nonNcaCollectionFeeCents: fee } }
}
