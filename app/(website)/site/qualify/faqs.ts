/**
 * Shared FAQ source data for /site/qualify.
 *
 * Imported by both the (client-component) page and the (server-component)
 * layout so the rendered FAQ items always match the FAQPage JSON-LD schema.
 * Google penalises FAQPage markup that doesn't match what's visible on the
 * page, so this single-source-of-truth pattern is load-bearing.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"

export type QualifyFaqGroup = "How the check works" | "Your result & eligibility"

export interface QualifyFaq {
  group: QualifyFaqGroup
  question: string
  answer: string
}

// Render order for the grouped FAQ section headings on /site/qualify.
export const QUALIFY_FAQ_GROUPS: readonly QualifyFaqGroup[] = [
  "How the check works",
  "Your result & eligibility",
] as const

export function qualifyFaqs(identity: Pick<LenderIdentity, "tradingName">): readonly QualifyFaq[] {
  return [
  {
    group: "How the check works",
    question: "Is this a credit check?",
    answer:
      "No. This step is an indicative eligibility check based on the details you share. A full credit and affordability assessment happens later, once you submit a formal application with the required documents.",
  },
  {
    group: "How the check works",
    question: "Will it affect my credit score?",
    answer:
      "No bureau enquiry is run during the eligibility check. A bureau enquiry is only performed once you proceed to a formal application and consent to it.",
  },
  {
    group: "How the check works",
    question: "What information do I need to check if I qualify?",
    answer:
      "You need your monthly gross income, your monthly expenses, and the loan amount and term you are considering. The tool uses these to show an indicative affordability result.",
  },
  {
    group: "Your result & eligibility",
    question: "Does eligibility guarantee approval?",
    answer:
      "No. A positive eligibility result indicates that the basic criteria are met. Approval is still subject to a full NCA affordability assessment, document verification and product-sheet disclosure.",
  },
  {
    group: "Your result & eligibility",
    question: `Who can qualify for a ${identity.tradingName} loan?`,
    answer:
      "Salaried employees, self-employed applicants, pensioners and grant recipients with regular, verifiable income are considered. Every application is assessed individually against NCA affordability rules.",
  },
  {
    group: "Your result & eligibility",
    question: "What happens after I qualify?",
    answer:
      "If the indicative result looks positive, you can continue to a full application. You will submit supporting documents and consent to the NCA-mandated affordability and credit checks before any offer is made.",
  },
]
}
