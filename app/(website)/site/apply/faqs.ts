/**
 * Shared FAQ source data for /site/apply.
 *
 * Imported by both the (client-component) page and the (server-component)
 * layout so the rendered "Application FAQ" items always match the FAQPage
 * JSON-LD schema. Google penalises FAQPage markup that doesn't match what's
 * visible on the page, so this single-source-of-truth pattern is load-bearing.
 */
export interface ApplyFaq {
  question: string
  answer: string
}

export const APPLY_FAQS: readonly ApplyFaq[] = [
  {
    question: "What documents do I need?",
    answer:
      "Usually a valid SA ID, recent proof of income (payslip or bank statements), proof of bank account in your name and proof of address. Purchase order funding additionally requires a verifiable purchase order.",
  },
  {
    question: "How long does the application take?",
    answer:
      "The online form itself takes around 10 to 15 minutes. After submission, timing depends on document checks, affordability review, approval workflow and, for purchase order funding, purchase-order verification.",
  },
  {
    question: "Will my information be safe?",
    answer:
      "Yes. Your application is processed under POPIA-aware consent and document handling. See the Privacy & POPIA Notice for your data-subject rights and how your information is stored, used and shared.",
  },
  {
    question: "What happens after I submit?",
    answer:
      "The credit team reviews documents, runs the NCA affordability assessment, and confirms the outcome by SMS, email or advisor contact. Approved applications proceed to pre-agreement statement, signature and disbursement.",
  },
]
