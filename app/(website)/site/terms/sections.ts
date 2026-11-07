import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { SiteJurisdiction } from "@/lib/website/site-jurisdiction"

export type TermsIdentity = Pick<LenderIdentity, "tradingName" | "legalName" | "ncrNumber" | "fspNumber">

export interface TermsSection {
  heading: string
  body: string[]
  links?: { label: string; href: string }[]
}

// White-label: the South African wording is unchanged; only the lender's
// identity values are substituted from its own LenderIdentity. Section 3's
// pricing link points at the calculators, because the pricing page is gone.
// A lender outside the NCA gets neutral wording built from the country's name:
// no statute is named, since none has been confirmed for it.
const southAfricanSections = (identity: TermsIdentity): TermsSection[] => [
  {
    heading: "1. Using this website",
    body: [
      `This website provides information about ${identity.tradingName}'s credit, insurance-enquiry and capital services, and tools such as loan calculators and an eligibility check. The figures shown by the calculators and eligibility check are indicative estimates only — they are not an offer of credit and do not guarantee approval or final pricing.`,
      "You agree to use this website lawfully and not to misuse the application, contact or portal forms (for example by submitting another person's information without their consent).",
    ],
  },
  {
    heading: "2. Credit and lending",
    body: [
      "All credit is provided subject to a full affordability assessment and credit check as required by the National Credit Act (NCA) No. 34 of 2005. Approval, the amount advanced, the term and the final cost of credit are confirmed only after that assessment.",
      "The full, binding terms and conditions of any loan — including the interest rate, fees, repayment schedule and your rights — are set out in your pre-agreement statement and credit agreement, which you receive and sign before any money is disbursed. Those signed documents govern your loan.",
    ],
  },
  {
    heading: "3. Fees and cost of credit",
    body: [
      "Initiation fees, service fees and interest are disclosed to you in the pre-agreement statement before you sign, in line with the NCA and the National Credit Regulations. Indicative pricing is summarised on our pricing page.",
    ],
    links: [{ label: "See pricing", href: "/site/calculators" }],
  },
  {
    heading: "4. Insurance enquiries",
    body: [
      `Insurance is offered on an enquiry basis. ${identity.tradingName} acts as an authorised intermediary (FSP ${identity.fspNumber}); policies are issued and underwritten by the relevant insurer under that insurer's own terms, subject to an advisor suitability review.`,
    ],
  },
  {
    heading: "5. Privacy and your information",
    body: [
      "We process your personal information in line with the Protection of Personal Information Act (POPIA). How we collect, use, store and protect your information — and your rights — are set out in our Privacy & POPIA notice.",
    ],
    links: [{ label: "Read the Privacy & POPIA notice", href: "/site/privacy" }],
  },
  {
    heading: "6. Complaints",
    body: [
      "If something goes wrong, we want to put it right. Lodge a complaint with us first, through our contact page. If we do not resolve it, you can take a credit complaint to the Credit Ombud or the National Credit Regulator, which can refer a matter to the National Consumer Tribunal; complaints about an insurance policy or claim go to the National Financial Ombud, and complaints about the advice or service of a financial intermediary to the FAIS Ombud.",
    ],
    links: [{ label: "Lodge a complaint", href: "/site/contact#complaints" }],
  },
  {
    heading: "7. Regulatory status",
    body: [
      `${identity.legalName} is a registered credit provider${identity.ncrNumber ? ` (NCR Reg ${identity.ncrNumber})` : ""}${identity.fspNumber ? ` and an authorised financial services provider (FSP ${identity.fspNumber})` : ""}. Full regulatory details are available on our regulatory information page.`,
    ],
    links: [{ label: "Regulatory information", href: "/site/regulatory-information" }],
  },
  {
    heading: "8. Governing law and changes to these terms",
    body: [
      `These terms, and your use of the ${identity.tradingName} website, are governed by the laws of the Republic of South Africa, and the South African courts have jurisdiction. Any credit or insurance product remains subject to the laws that apply to it, including the National Credit Act and the Financial Advisory and Intermediary Services Act.`,
      "We may update these terms from time to time; the version published on this page is the current one. Last updated: 5 July 2026.",
    ],
  },
]

const neutralSections = (identity: TermsIdentity, country: string): TermsSection[] => [
  {
    heading: "1. Using this website",
    body: [
      `This website provides information about ${identity.tradingName}'s credit and capital services, and tools such as loan calculators and an eligibility check. The figures shown by the calculators and eligibility check are indicative estimates only — they are not an offer of credit and do not guarantee approval or final pricing.`,
      "You agree to use this website lawfully and not to misuse the application, contact or portal forms (for example by submitting another person's information without their consent).",
    ],
  },
  {
    heading: "2. Credit and lending",
    body: [
      "All credit is provided subject to a full affordability assessment and credit check. Approval, the amount advanced, the term and the final cost of credit are confirmed only after that assessment.",
      "The full, binding terms and conditions of any loan — including the interest rate, fees, repayment schedule and your rights — are set out in the offer letter, key facts statement and loan agreement you receive from us. The signed loan agreement governs your loan.",
    ],
  },
  {
    heading: "3. Fees and cost of credit",
    body: [
      "Fees, charges and interest are disclosed to you in the key facts statement before you commit. Indicative figures are available in our loan calculators.",
    ],
    links: [{ label: "See pricing", href: "/site/calculators" }],
  },
  {
    heading: "4. Privacy and your information",
    body: [
      `We process your personal information in line with the data-protection law that applies in ${country}. How we collect, use, store and protect your information — and your rights — are set out in our Privacy notice.`,
    ],
    links: [{ label: "Read the Privacy notice", href: "/site/privacy" }],
  },
  {
    heading: "5. Complaints",
    body: [
      `If something goes wrong, we want to put it right. Lodge a complaint with us first, through our contact page. If we do not resolve it, you may take it to the regulator or ombud that applies to your credit product in ${country}.`,
    ],
    links: [{ label: "Lodge a complaint", href: "/site/contact#complaints" }],
  },
  {
    heading: "6. Governing law and changes to these terms",
    body: [
      `These terms, and your use of the ${identity.tradingName} website, are governed by the laws of ${country}, and its courts have jurisdiction. Any credit product remains subject to the laws that apply to it.`,
      "We may update these terms from time to time; the version published on this page is the current one. Last updated: 5 July 2026.",
    ],
  },
]

export function termsSections(identity: TermsIdentity, site: SiteJurisdiction): TermsSection[] {
  return site.nca ? southAfricanSections(identity) : neutralSections(identity, site.countryName)
}

/** Whether the terms mention insurance: a South African lender that holds an FSP number. */
export const termsCoverInsurance = (identity: TermsIdentity, site: SiteJurisdiction): boolean => site.nca && !!identity.fspNumber

export function termsIntro(identity: Pick<LenderIdentity, "tradingName" | "fspNumber">, site: SiteJurisdiction): string {
  if (!site.nca) {
    return `These terms apply to your use of the ${identity.tradingName} website and to any credit or capital service you request. The full, binding terms of a loan are set out in the loan agreement you sign.`
  }
  return `These terms apply to your use of the ${identity.tradingName} website and to any credit${identity.fspNumber ? ", insurance enquiry" : ""} or capital service you request. The full, binding terms of a loan are set out in the credit agreement you sign.`
}

export function termsNotice(site: SiteJurisdiction): string {
  if (!site.nca) {
    return "these terms govern your use of this website. The full, binding terms of a specific product are set out in the documents you receive and sign — your offer letter, key facts statement and loan agreement for a loan — and those signed documents take precedence over the summaries on this page."
  }
  return "these terms govern your use of this website. The full, binding terms of a specific product are set out in the documents you receive and sign — your pre-agreement statement and credit agreement for a loan, or the insurer's policy documents for insurance — and those signed documents take precedence over the summaries on this page."
}
