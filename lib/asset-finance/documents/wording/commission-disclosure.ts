// The dealer commission disclosure (slice 5 follow-ups part W, goal §2a 2):
// one protected paragraph, printed only on a deal a dealer introduced
// (AssetFinanceDeal.dealerId). It says that the lender may pay the dealer a
// commission, from its own funds, and that it is no part of what the borrower
// pays. It is a statement, never a figure: the commission is not a charge, so
// no amount, rate or total on any document includes or mentions it.
// Unnumbered and printed inside the document's price section, so clause
// numbering, and the numbers lender additional terms take, are the same on a
// dealer and a non-dealer deal. Not editable by the lender, and
// templates/validate.ts refuses the word "commission" in lender text.
// Wording notes: docs/asset-finance/SLICE5-FOLLOWUPS.md "Part W".

/** The dealer that introduced the deal: the name the clause prints. */
export interface DocumentDealer {
  name: string
}

/** The clause in each document's defined terms. */
interface Terms {
  lender: string
  /** What the dealer introduced, e.g. "this Agreement". */
  introduced: string
  /** The sentence saying the commission is no part of what the borrower pays. */
  notCharged: string
}

const NCA_NOT_CHARGED = "It is not charged to the Consumer: it is not part of the cash price, the principal debt, the interest, the fees, the instalments or any other amount the Consumer pays or owes, and it is not part of the total cost of credit shown above."

const TERMS = {
  INSTALMENT_SALE: {
    lender: "The Seller", introduced: "this Agreement",
    notCharged: "It is not part of the cash price, the payments in the Schedule or any other amount the Purchaser pays or owes under this Agreement, and it does not increase any of them.",
  },
  LEASE: {
    lender: "The lessor", introduced: "this agreement",
    notCharged: "It is not part of the rentals or any other amount the lessee pays or owes under this agreement, and it does not increase any of them.",
  },
  NCA_AGREEMENT: { lender: "The Credit Provider", introduced: "this agreement to the Credit Provider", notCharged: NCA_NOT_CHARGED },
  NCA_QUOTATION: { lender: "The Credit Provider", introduced: "the proposed agreement to the Credit Provider", notCharged: NCA_NOT_CHARGED },
} as const satisfies Record<string, Terms>

export type CommissionDocument = keyof typeof TERMS

/** The paragraph for `dealer` on `document`; the caller prints it only when the deal has a dealer. */
export function commissionDisclosure(document: CommissionDocument, dealer: DocumentDealer): string {
  const t: Terms = TERMS[document]
  return `Dealer commission. ${t.lender} may pay a commission to ${dealer.name}, the dealer that introduced ${t.introduced}. ${t.lender} pays any commission from its own funds. ${t.notCharged}`
}
