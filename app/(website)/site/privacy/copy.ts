import type { SiteJurisdiction } from "@/lib/website/site-jurisdiction"

// Legal copy: the South African wording is unchanged from the inherited policy.
// A lender outside the NCA gets neutral wording built from the country's name; no
// statute or regulator is named, since none has been confirmed for it. Client
// legal must sign this page off before go-live.

export interface PrivacyCopy {
  title: string
  description: (brand: string) => string
  eyebrow: string
  intro: (brand: string) => string
  identityBody: string
  snapshotBody: string
  showNcrRegistration: boolean
  uses: string[]
  sharing: (brand: string) => string
  safeguards: string[]
  rightsEyebrow: string
  /** Link to the data-protection regulator; null when none is named. */
  regulatorLink: { label: string; href: string } | null
  rights: (brand: string) => string[][]
  retention: (brand: string) => string
  escalation: string
  /** The regulator's complaints mailbox; null when none is named. */
  complaintsEmail: { label: string; address: string } | null
}

const sharing = (insurers: boolean) => (brand: string) =>
  `${brand} does not sell personal information. Information may be shared with credit bureaux, payment and banking partners, verification providers, ${insurers ? "insurers or underwriting partners, " : ""}professional advisors, regulators and law-enforcement bodies where there is a lawful basis.`

const rightsList = (brand: string, complaint: string) => [
  ["Access", `Ask what personal information ${brand} holds about you.`],
  ["Correction", "Request correction of inaccurate or incomplete information."],
  ["Objection", "Object to certain processing, including direct marketing."],
  ["Withdrawal", "Withdraw consent where processing depends on consent."],
  ["Deletion", "Request deletion where there is no lawful reason to retain the record."],
  ["Complaint", complaint],
]

const southAfrican: PrivacyCopy = {
  title: "Privacy Policy & POPIA Notice",
  description: (brand) => `How ${brand} collects, uses, stores and protects your personal information under POPIA. Includes your data subject rights and contact details.`,
  eyebrow: "POPIA and client trust",
  intro: (brand) => `${brand} collects and processes personal information to assess applications, meet regulatory duties, protect clients and provide lending, insurance and related financial-service support.`,
  identityBody: "Name, South African ID number, date of birth, phone number, email address and address details.",
  snapshotBody: "This page explains how client information moves through the website, eligibility, application, portal and servicing workflows. It supports POPIA transparency, NCA affordability requirements and insurance disclosure readiness.",
  showNcrRegistration: true,
  uses: [
    "Assess loan, insurance and related financial-service requests",
    "Verify identity, reduce fraud risk and meet FICA, NCA and POPIA duties",
    "Calculate affordability, prepare disclosures and communicate application outcomes",
    "Administer accounts, repayments, claims, renewals and client support",
    "Report where required to regulators, credit bureaux and approved service partners",
    "Send relevant product information where the client has consented or where law allows it",
  ],
  sharing: sharing(true),
  safeguards: [
    "Role-based access controls for staff and advisors",
    "Secure application and document workflows",
    "Audit trails for sensitive operational actions",
    "Retention aligned to credit, FICA and regulatory record obligations",
  ],
  rightsEyebrow: "Your POPIA rights",
  regulatorLink: { label: "Information Regulator", href: "https://inforegulator.org.za/" },
  rights: (brand) => rightsList(brand, `Complain to ${brand} or the Information Regulator of South Africa.`),
  retention: (brand) => `${brand} retains information for as long as needed to provide services, resolve disputes, meet credit and insurance obligations and comply with applicable laws. Credit and FICA-related records are typically kept for at least five years after the relationship ends, unless a longer period is required.`,
  escalation: "Information Regulator of South Africa",
  complaintsEmail: { label: "POPIA complaints:", address: "POPIAComplaints@inforegulator.org.za" },
}

const neutral = (country: string): PrivacyCopy => ({
  title: "Privacy Policy",
  description: (brand) => `How ${brand} collects, uses, stores and protects your personal information under the data-protection law that applies in ${country}. Includes your data rights and contact details.`,
  eyebrow: "Data protection and client trust",
  intro: (brand) => `${brand} collects and processes personal information to assess applications, meet regulatory duties, protect clients and provide lending and related financial-service support.`,
  identityBody: "Name, national ID number, date of birth, phone number, email address and address details.",
  snapshotBody: `This page explains how client information moves through the website, eligibility, application, portal and servicing workflows. It supports transparency under the data-protection law that applies in ${country}, affordability assessment and disclosure readiness.`,
  showNcrRegistration: false,
  uses: [
    "Assess loan and related financial-service requests",
    "Verify identity, reduce fraud risk and meet the credit, anti-money-laundering and data-protection duties that apply",
    "Calculate affordability, prepare disclosures and communicate application outcomes",
    "Administer accounts, repayments and client support",
    "Report where required to regulators, credit bureaux and approved service partners",
    "Send relevant product information where the client has consented or where law allows it",
  ],
  sharing: sharing(false),
  safeguards: [
    "Role-based access controls for staff and advisors",
    "Secure application and document workflows",
    "Audit trails for sensitive operational actions",
    "Retention aligned to credit and regulatory record obligations",
  ],
  rightsEyebrow: "Your data-protection rights",
  regulatorLink: null,
  rights: (brand) => rightsList(brand, `Complain to ${brand} or the data-protection authority in ${country}.`),
  retention: (brand) => `${brand} retains information for as long as needed to provide services, resolve disputes, meet credit obligations and comply with applicable laws. Records are kept for the period that applicable law requires.`,
  escalation: `The data-protection authority in ${country}`,
  complaintsEmail: null,
})

export function privacyCopy(site: SiteJurisdiction): PrivacyCopy {
  return site.nca ? southAfrican : neutral(site.countryName)
}
