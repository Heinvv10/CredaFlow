/**
 * Shared FAQ source data for /site/contact.
 *
 * Imported by both the (client-component) page and the (server-component)
 * layout so the rendered FAQ items always match the FAQPage JSON-LD schema.
 * Google penalises FAQPage markup that doesn't match what's visible on the
 * page, so this single-source-of-truth pattern is load-bearing.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"

export interface ContactFaq {
  question: string
  answer: string
}

export function contactFaqs(
  identity: Pick<LenderIdentity, "tradingName" | "registeredOfficeLines" | "publicWhatsapp">,
): readonly ContactFaq[] {
  return [
  {
    question: `How long does ${identity.tradingName} take to respond?`,
    answer:
      "The team aims to acknowledge new enquiries within one business day. Complex advisor enquiries and complaints may take longer; you will receive a reference number for tracking.",
  },
  {
    // Hours are Monday–Friday only.
    // Keep in sync with the visible hours block in ./page.tsx.
    question: "What are your office hours?",
    answer:
      "The team is available Monday to Friday, 08:00 to 17:00 (SAST). We are closed on weekends and public holidays. Messages sent outside these hours are answered on the next business day.",
  },
  {
    question: "Which contact method should I use?",
    answer:
      `Use ${identity.publicWhatsapp ? "WhatsApp or phone" : "phone"} for quick questions, email for documents or detailed queries, and the form on this page for a tracked enquiry. To apply for a loan, use the eligibility check and online application instead.`,
  },
  {
    question: "How do I lodge a complaint?",
    answer:
      "Use the form above and mark your enquiry as a complaint. Complaints are handled in line with NCA and FAIS escalation routes. Unresolved complaints may be referred to the National Consumer Tribunal (NCT) for credit-related matters or the FAIS Ombud for financial advisory matters.",
  },
  {
    question: "Can I apply for a loan through this form?",
    answer:
      "No. Applications go through the eligibility check and online application path so we can capture POPIA-compliant consent and run the required affordability assessment.",
  },
  {
    question: `Where is ${identity.tradingName} based?`,
    answer:
      `Our office is at ${identity.registeredOfficeLines.join(", ")}. Office visits are by appointment so the right advisor is available to assist you.`,
  },
]
}
