import { findLenderIdentity, formatIdentityDate, type LenderIdentity } from "@/lib/config/identity"
import { prisma } from "@/lib/prisma"
import {
  applyLivePricing, formatInterestLabel, formatProductRange, formatProductTermRange, type PublicLoanProduct,
} from "@/lib/public-loan-products"
import { getLivePricingServer } from "@/lib/public-loan-products-server"
import { ZA_SITE, type SiteJurisdiction } from "@/lib/website/site-jurisdiction"
import { getSiteJurisdiction } from "@/lib/website/site-jurisdiction.server"

// Only what the tenant has published: its own identity, the loan and insurance products it
// has switched on, and the website pages that exist. Adding a source here is a content
// decision for the lender to sign off, not a code tidy-up.
const PAGES: ReadonlyArray<[string, string]> = [
  ["Repayment and affordability calculators", "/site/calculators"],
  ["Check if you may qualify", "/site/qualify"],
  ["Apply online", "/site/apply"],
  ["Contact us", "/site/contact"],
  ["Regulatory information", "/site/regulatory-information"],
  ["Privacy policy", "/site/privacy"],
  ["Terms", "/site/terms"],
]

const INSURANCE_TYPE_LABEL: Record<string, string> = {
  FUNERAL_COVER: "funeral cover",
  CREDIT_LIFE: "credit life",
  LIFE_INSURANCE: "life insurance",
}

export type InsuranceFact = { name: string; type: string }

// The pages that exist only under the NCA (lib/registry/nca-only/): the regulatory information page.
const NCA_ONLY_PAGES: ReadonlySet<string> = new Set(["/site/regulatory-information"])

export function buildKnowledge(a: { identity: LenderIdentity; products: PublicLoanProduct[]; insurance: InsuranceFact[]; site?: SiteJurisdiction }): string {
  const { identity: id, products, insurance, site = ZA_SITE } = a
  // Outside the NCA the lender holds no NCR or FSP registration to state and sells no insurance.
  const company = site.nca ? [
    `${id.legalName}.${id.ncrNumber ? ` NCR registration ${id.ncrNumber}.` : ""}${id.fspNumber ? ` FSP licence ${id.fspNumber}.` : ""} Company registration ${id.companyRegNumber}.`,
    id.ncrStatus && `NCR status: ${id.ncrStatus}.`,
    id.ncrRegistrationDate && `Registered with the NCR on ${formatIdentityDate(id.ncrRegistrationDate)}.`,
    id.fspNumber && id.fscaAuthorisationDate && `Authorised as an FSP on ${formatIdentityDate(id.fscaAuthorisationDate)}.`,
    id.headOfficeCity && `Head office: ${id.headOfficeCity}.`,
  ] : [
    `${id.legalName}. Company registration ${id.companyRegNumber}.`,
    id.headOfficeCity && `Head office: ${id.headOfficeCity}.`,
  ]
  const companyLines = company.filter((l): l is string => Boolean(l))
  const contact = `Phone ${id.publicPhone}.${id.publicWhatsapp ? ` WhatsApp ${id.publicWhatsapp}.` : ""} Email ${id.publicEmail}.`
  const productLines = products.map((p) =>
    `- ${p.label}: ${p.description} Amounts ${formatProductRange(p)}; terms ${formatProductTermRange(p)}; ${formatInterestLabel(p)}.`)
  // A lender with no FSP number offers no insurance: none is named, and its
  // insurance page (which 404s) is not linked.
  const offered = site.nca && id.fspNumber ? insurance : []
  const insuranceLines = offered.map((i) => `- ${i.name} (${INSURANCE_TYPE_LABEL[i.type] ?? "insurance"})`)
  const ownPages = site.nca ? PAGES : PAGES.filter(([, path]) => !NCA_ONLY_PAGES.has(path))
  const pages = offered.length ? [...ownPages, ["Insurance", "/site/products/insurance"] as const] : ownPages

  return [
    "## Company",
    ...companyLines,
    contact,
    "",
    "## Loan products (as published on the website)",
    ...(productLines.length ? productLines : ["- None are currently offered online."]),
    ...(insuranceLines.length ? ["", "## Insurance products", ...insuranceLines] : []),
    "",
    "## Website pages",
    ...pages.map(([label, path]) => `- ${label}: ${path}`),
  ].join("\n")
}

/** The chat's knowledge for a tenant whose identity is already read: its live loan products and active insurance. */
export async function knowledgeFor(tenantId: string, identity: LenderIdentity): Promise<string> {
  const pricing = await getLivePricingServer(tenantId)
  const products = applyLivePricing(pricing).filter((p) => pricing[p.code])
  const insurance = await prisma.insuranceProduct.findMany({
    where: { tenantId, active: true }, select: { name: true, type: true }, orderBy: [{ type: "asc" }, { name: "asc" }],
  })
  return buildKnowledge({ identity, products, insurance, site: await getSiteJurisdiction() })
}

/**
 * The chat's knowledge for one tenant, read from its own rows. Null when the tenant has no
 * lender identity: there is nothing true to say, so the caller must not run the chat.
 */
export async function loadKnowledge(tenantId: string): Promise<{ identity: LenderIdentity; knowledge: string } | null> {
  const identity = await findLenderIdentity(tenantId)
  return identity ? { identity, knowledge: await knowledgeFor(tenantId, identity) } : null
}
