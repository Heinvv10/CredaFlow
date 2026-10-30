import type { LoanDocumentKind } from "@prisma/client"

/**
 * The lender's two templates for a key-facts application (lib/non-nca-documents):
 * one CUSTOM DocumentTemplate each, with dual-approved versions
 * (app/api/documents/templates). The keys are fixed: a CHECK on LoanDocumentIssuance
 * names the same two.
 */
export const LOAN_DOCUMENT_TEMPLATE_KEYS: Record<LoanDocumentKind, string> = {
  KEY_FACTS_STATEMENT: "non_nca_key_facts",
  LOAN_AGREEMENT: "non_nca_loan_agreement",
}

export const LOAN_DOCUMENT_LABELS: Record<LoanDocumentKind, string> = {
  KEY_FACTS_STATEMENT: "Key facts statement",
  LOAN_AGREEMENT: "Loan agreement",
}

/**
 * Printed at the head of every document a DEMO lender (TenantConfig.isDemoLender)
 * issues. The lender's own legal wording is the bank's to supply; a demo carries
 * structure and the approved figures, never invented legal text.
 */
export const SAMPLE_BANNER_TEXT = "SAMPLE \u2014 the bank\u2019s legal team supplies wording"

export const LOAN_DOCUMENT_KINDS: readonly LoanDocumentKind[] = ["KEY_FACTS_STATEMENT", "LOAN_AGREEMENT"]

/** The two template keys whose wording is the lender's approved legal text (approval is unconditional). */
export const isLoanDocumentTemplateKey = (key: string) => Object.values(LOAN_DOCUMENT_TEMPLATE_KEYS).includes(key)
