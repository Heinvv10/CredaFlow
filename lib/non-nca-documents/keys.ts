import type { LoanDocumentKind } from "@prisma/client"

/**
 * The lender's templates for a key-facts application (lib/non-nca-documents):
 * one CUSTOM DocumentTemplate each, with dual-approved versions
 * (app/api/documents/templates). The keys are fixed: a CHECK on LoanDocumentIssuance
 * names the same ones, and guardLoanDocumentTemplate covers them and the arrears letter's.
 */
export const LOAN_DOCUMENT_TEMPLATE_KEYS: Record<LoanDocumentKind, string> = {
  OFFER_LETTER: "non_nca_offer_letter",
  KEY_FACTS_STATEMENT: "non_nca_key_facts",
  LOAN_AGREEMENT: "non_nca_loan_agreement",
}

/** The arrears letter of a key-facts loan (arrears-letter.ts). Issued against a loan, so it is not an issuance kind. */
export const ARREARS_LETTER_TEMPLATE_KEY = "non_nca_arrears_letter"

export const LOAN_DOCUMENT_LABELS: Record<LoanDocumentKind, string> = {
  OFFER_LETTER: "Offer letter",
  KEY_FACTS_STATEMENT: "Key facts statement",
  LOAN_AGREEMENT: "Loan agreement",
}

/**
 * Printed at the head of every document a DEMO lender (TenantConfig.isDemoLender)
 * issues. The lender's own legal wording is the bank's to supply; a demo carries
 * structure and the approved figures, never invented legal text.
 */
export const SAMPLE_BANNER_TEXT = "SAMPLE — the bank’s legal team supplies wording"

/** In the order the borrower deals with them. */
export const LOAN_DOCUMENT_KINDS: readonly LoanDocumentKind[] = ["OFFER_LETTER", "KEY_FACTS_STATEMENT", "LOAN_AGREEMENT"]

/** The template keys whose wording is the lender's approved legal text (approval is unconditional). */
export const isLoanDocumentTemplateKey = (key: string) => key === ARREARS_LETTER_TEMPLATE_KEY || Object.values(LOAN_DOCUMENT_TEMPLATE_KEYS).includes(key)
