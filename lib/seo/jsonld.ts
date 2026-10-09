import type { LenderIdentity } from "@/lib/config/identity-schema"
import { siteUrl } from "@/lib/seo/metadata"

// Every value about the lender comes from its own LenderIdentity
// (lib/config/identity.ts); there is no constant fallback. Ids are relative to
// NEXT_PUBLIC_WEBSITE_URL, or root-relative when it is unset.
const orgId = () => `${siteUrl()}/#organization`
const websiteId = () => `${siteUrl()}/#website`

/** Build the Schema.org Organization (FinancialService) node. Emit once site-wide. */
export function organizationLd(identity: LenderIdentity) {
  return {
    "@context": "https://schema.org",
    "@type": "FinancialService",
    "@id": orgId(),
    name: identity.tradingName,
    // legalName surfaces the registered entity behind the brand, which is how
    // crawlers resolve the brand to the NCR and FSCA register entries.
    legalName: identity.legalName,
    ...(siteUrl() ? { url: siteUrl() } : {}),
    description:
      `${identity.legalName} is a South African credit provider. ` +
      `Registered with the National Credit Regulator under ${identity.ncrNumber} and ` +
      `authorised by the Financial Sector Conduct Authority as a financial services provider under FSP number ${identity.fspNumber}.`,
    // Schema.org telephone + Google's structured-data guidance prefer E.164
    // format (no spaces, leading +). Visible copy uses the spaced form.
    telephone: identity.publicPhoneE164,
    email: identity.publicEmail,
    address: {
      "@type": "PostalAddress" as const,
      streetAddress: identity.registeredOfficeLines.join(", "),
      addressCountry: "ZA",
    },
    areaServed: { "@type": "Country", name: "South Africa" },
    identifier: [
      { "@type": "PropertyValue", propertyID: "NCR Registration", value: identity.ncrNumber },
      { "@type": "PropertyValue", propertyID: "FSP Licence", value: identity.fspNumber },
      { "@type": "PropertyValue", propertyID: "CIPC Registration", value: identity.companyRegNumber },
    ],
    contactPoint: [
      {
        "@type": "ContactPoint" as const,
        contactType: "customer support",
        telephone: identity.publicPhoneE164,
        email: identity.publicEmail,
        areaServed: "ZA",
        availableLanguage: ["en-ZA"],
      },
      ...(identity.publicWhatsappE164
        ? [{
            "@type": "ContactPoint" as const,
            contactType: "WhatsApp support",
            telephone: identity.publicWhatsappE164,
            areaServed: "ZA",
            availableLanguage: ["en-ZA"],
          }]
        : []),
    ],
  } as const
}

/** Build the Schema.org WebSite node. Emit once site-wide. */
export function webSiteLd(identity: LenderIdentity) {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": websiteId(),
    name: identity.tradingName,
    ...(siteUrl() ? { url: siteUrl() } : {}),
    publisher: { "@id": orgId() },
    inLanguage: "en-ZA",
  } as const
}

export interface BreadcrumbItem {
  name: string
  /** Path on the public site, starting with "/". */
  path: string
}

/** Build a BreadcrumbList from a navigation trail. */
export function breadcrumbLd(trail: BreadcrumbItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem" as const,
      position: index + 1,
      name: item.name,
      item: `${siteUrl()}${item.path === "/" ? "" : item.path}`,
    })),
  }
}

export interface FinancialServiceLdInput {
  name: string
  description: string
  path: string
  /** Free-form serviceType label. */
  serviceType?: string
}

/** Build a FinancialService node for a non-credit product page (insurance). */
export function financialServiceLd(input: FinancialServiceLdInput) {
  return {
    "@context": "https://schema.org",
    "@type": "FinancialService",
    name: input.name,
    description: input.description,
    url: `${siteUrl()}${input.path}`,
    provider: { "@id": orgId() },
    areaServed: { "@type": "Country" as const, name: "South Africa" },
    ...(input.serviceType ? { serviceType: input.serviceType } : {}),
  }
}

export interface FaqItem {
  question: string
  answer: string
}

/**
 * Build a FAQPage node from a list of Q&A pairs. Consumers must ensure the
 * items here match what's rendered on the page — Google penalises mismatched
 * FAQPage schema as deceptive markup.
 */
export function faqLd(items: readonly FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question" as const,
      name: item.question,
      acceptedAnswer: {
        "@type": "Answer" as const,
        text: item.answer,
      },
    })),
  }
}

export interface WebApplicationLdInput {
  name: string
  description: string
  path: string
  /** Free-form category (e.g. "FinanceApplication"). */
  applicationCategory?: string
}

/** Build a WebApplication node for interactive tools (calculators, qualify checks). */
export function webApplicationLd(input: WebApplicationLdInput) {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: input.name,
    description: input.description,
    url: `${siteUrl()}${input.path}`,
    publisher: { "@id": orgId() },
    inLanguage: "en-ZA",
    isAccessibleForFree: true,
    ...(input.applicationCategory
      ? { applicationCategory: input.applicationCategory }
      : {}),
  }
}

export interface ContactPageLdInput {
  name: string
  description: string
  path: string
  email?: string
}

/** Build a ContactPage node for the contact/complaints page. */
export function contactPageLd(input: ContactPageLdInput) {
  return {
    "@context": "https://schema.org",
    "@type": "ContactPage",
    name: input.name,
    description: input.description,
    url: `${siteUrl()}${input.path}`,
    publisher: { "@id": orgId() },
    ...(input.email
      ? {
          mainEntity: {
            "@type": "ContactPoint" as const,
            contactType: "customer support",
            email: input.email,
          },
        }
      : {}),
  }
}
