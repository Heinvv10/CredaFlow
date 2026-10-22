// The introducer's commission disclosure (slice 5 follow-ups part W, goal §2a 2):
// one fixed, protected paragraph, printed only on a deal a dealer or broker
// introduced (AssetFinanceDeal.dealerId). It says that the lender may pay the
// introducer a commission, from its own funds, and that it is no part of what
// the borrower pays. The introducer is named in a labelled row printed with
// it ("Introducer", ./dealer-name.ts), never inside the wording, so the
// fingerprinted text is the same for every dealer. A statement, never a figure:
// no amount, rate or total on any document includes or mentions the commission.
// On the contracts the row and paragraph end the price section, unnumbered, so
// clause numbering, and the numbers lender additional terms take, are the same
// on a dealer and a non-dealer deal; the NCA documents give it a section of its
// own, outside the cost-of-credit disclosure. Not editable by the lender, and
// templates/validate.ts refuses the word "commission" in lender text.
// Wording notes: docs/asset-finance/SLICE5-FOLLOWUPS.md "Part W".
import { DealDocumentError } from "../deal-document-error"
import { dealerPrintRefusal, type DocumentDealer } from "./dealer-name"

/** The paragraph in each document's defined terms. */
const TERMS = {
  INSTALMENT_SALE: "Introducer's commission. The Seller may pay a commission to the introducer named above, which introduced the Purchaser to the Seller for this Agreement. The Seller pays any commission from its own funds. It is not part of the cash price, the payments in the Schedule or any other amount the Purchaser pays or owes under this Agreement.",
  LEASE: "Introducer's commission. The lessor may pay a commission to the introducer named above, which introduced the lessee to the lessor for this agreement. The lessor pays any commission from its own funds. It is not part of the rentals or any other amount the lessee pays or owes under this agreement.",
  NCA_AGREEMENT: "The Credit Provider may pay a commission to the introducer named above, which introduced the Consumer to the Credit Provider for this agreement. The Credit Provider pays any commission from its own funds. It is not a fee or charge to the Consumer: it is not part of the cash price, the principal debt, the interest, the fees, the instalments or any other amount the Consumer pays or owes, and it is not included in the total cost of credit shown above.",
  NCA_QUOTATION: "The Credit Provider may pay a commission to the introducer named above, which introduced the Consumer to the Credit Provider for the proposed agreement. The Credit Provider pays any commission from its own funds. It is not a fee or charge to the Consumer: it is not part of the cash price, the principal debt, the interest, the fees, the instalments or any other amount the Consumer pays or owes, and it is not included in the total cost of credit shown above.",
} as const

export type CommissionDocument = keyof typeof TERMS

/** The fixed paragraph for `document`; the caller prints it, with `introducerRow`, only when the deal has a dealer. */
export const commissionDisclosure = (document: CommissionDocument): string => TERMS[document]

/** The "Introducer" label/value row. Refuses (the document is not issued) a name that cannot be printed: see ./dealer-name.ts. */
export function introducerRow(dealer: DocumentDealer): [string, string] {
  const refusal = dealerPrintRefusal(dealer.name)
  if (refusal) throw new DealDocumentError(refusal)
  return ["Introducer", `${dealer.name} (${dealer.kind === "BROKER" ? "broker" : "dealer"})`]
}
