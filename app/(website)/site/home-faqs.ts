/**
 * Homepage FAQ source. Used by both the visible FAQ section on the homepage
 * and the FAQPage JSON-LD emitted from app/page.tsx. Single source of truth
 * because Google penalises FAQPage schema that does not match what crawlers
 * see rendered.
 *
 * Kept short and high-level: site-wide entity-identification questions,
 * answered from the tenant's own identity and the products it offers.
 */
import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { PublicLoanProduct } from "@/lib/public-loan-products"

export interface HomeFaq {
  question: string
  answer: string
}

type HomeFaqIdentity = Pick<LenderIdentity, "tradingName" | "legalName" | "ncrNumber" | "fspNumber" | "headOfficeCity">

export function homeFaqs(identity: HomeFaqIdentity, products: readonly Pick<PublicLoanProduct, "label">[]): HomeFaq[] {
  const brand = identity.tradingName
  const offered = products.map((product) => product.label.toLowerCase())
  return [
    {
      question: `What is ${brand}?`,
      answer:
        `${brand} is the trading name of ${identity.legalName}, a South African credit provider registered with the ` +
        `National Credit Regulator (${identity.ncrNumber}) and authorised as a financial services provider (FSP ${identity.fspNumber}).`,
    },
    {
      question: `What does ${brand} offer?`,
      answer:
        (offered.length > 0 ? `${brand} offers ${offered.join(", ")} under its National Credit Act registration, and insurance enquiries. ` : `${brand} offers insurance enquiries. `) +
        "All credit applications are subject to NCA affordability assessment.",
    },
    {
      question: `How do I apply for a loan with ${brand}?`,
      answer:
        "Start with the online eligibility check or apply directly on the website. Applications require valid South African identification, proof of income and supporting documents. Final terms are subject to affordability checks and credit-bureau verification under the National Credit Act.",
    },
    {
      question: `Where does ${brand} operate?`,
      answer:
        (identity.headOfficeCity
          ? `${brand} serves clients across South Africa from its head office in ${identity.headOfficeCity}. `
          : `${brand} serves clients in South Africa. `) +
        "Services are delivered under South African regulatory requirements including the National Credit Act, FAIS and POPIA.",
    },
  ]
}
