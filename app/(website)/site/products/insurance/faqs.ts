import type { LenderIdentity } from "@/lib/config/identity-schema"

/** The insurance FAQ list for this lender. Page and FAQPage JSON-LD share it. */
export function insuranceFaqs(identity: LenderIdentity) {
  return [
    {
      question: `What is the ${identity.tradingName} insurance enquiry pathway?`,
      answer: `A FAIS-authorised intermediary pathway for clients to enquire about short-term insurance and credit-life insurance paths. ${identity.tradingName} discusses options, captures the relevant disclosure and routes the enquiry to a suitable advisor — insurance itself is provided by underwriters under their own product terms.`,
    },
    {
      question: "What kinds of insurance can I enquire about?",
      answer:
        "Funeral insurance paths, credit-life insurance for an existing loan, life insurance enquiries and short-term insurance enquiries. The exact products available depend on the underwriter, your circumstances and the suitability assessment that follows the initial enquiry.",
    },
    {
      question: "Who is the insurance pathway for?",
      answer:
        "Individuals, families and South African businesses looking to enquire about insurance alongside (or independently of) credit. The intent is to keep insurance and lending under one client relationship so disclosures, documents and advisor contacts are not fragmented.",
    },
    {
      question: "How does an enquiry become a policy?",
      answer:
        "An enquiry routes to an advisor who runs a suitability assessment under the FAIS framework. If a product matches your needs, the advisor explains the disclosures, costs and exclusions, and you make an informed decision. A policy is only issued under the underwriter's own application and acceptance process.",
    },
    {
      question: "What regulatory framework applies?",
      answer: `${identity.tradingName} acts as an authorised Financial Services Provider under the Financial Advisory and Intermediary Services Act (FAIS), FSP ${identity.fspNumber}. The FAIS General Code of Conduct sets out the intermediary's obligations on suitability and conflict-of-interest disclosure. Complaints follow the FAIS escalation route, with onward referral to the FAIS Ombud where required.`,
    },
  ]
}
