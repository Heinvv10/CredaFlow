import { findLenderIdentity, formatIdentityDate, type LenderIdentity } from "@/lib/config/identity"
import { prisma } from "@/lib/prisma"
import {
  applyLivePricing, formatInterestLabel, formatProductRange, formatProductTermRange, type PublicLoanProduct,
} from "@/lib/public-loan-products"
import { getLivePricingServer } from "@/lib/public-loan-products-server"

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

export function buildKnowledge(a: { identity: LenderIdentity; products: PublicLoanProduct[]; insurance: InsuranceFact[] }): string {
  const { identity: id, products, insurance } = a
  const company = [
    `${id.legalName}. NCR registration ${id.ncrNumber}. FSP licence ${id.fspNumber}. Company registration ${id.companyRegNumber}.`,
    id.ncrStatus && `NCR status: ${id.ncrStatus}.`,
    id.ncrRegistrationDate && `Registered with the NCR on ${formatIdentityDate(id.ncrRegistrationDate)}.`,
    id.fscaAuthorisationDate && `Authorised as an FSP on ${formatIdentityDate(id.fscaAuthorisationDate)}.`,
    id.headOfficeCity && `Head office: ${id.headOfficeCity}.`,
  ].filter((l): l is string => Boolean(l))
  const contact = `Phone ${id.publicPhone}.${id.publicWhatsapp ? ` WhatsApp ${id.publicWhatsapp}.` : ""} Email ${id.publicEmail}.`
  const productLines = products.map((p) =>
    `- ${p.label}: ${p.description} Amounts ${formatProductRange(p)}; terms ${formatProductTermRange(p)}; ${formatInterestLabel(p)}.`)
  const insuranceLines = insurance.map((i) => `- ${i.name} (${INSURANCE_TYPE_LABEL[i.type] ?? "insurance"})`)
  const pages = insurance.length ? [...PAGES, ["Insurance", "/site/products/insurance"] as const] : PAGES

  return [
    "## Company",
    ...company,
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
  return buildKnowledge({ identity, products, insurance })
}

/**
 * The chat's knowledge for one tenant, read from its own rows. Null when the tenant has no
 * lender identity: there is nothing true to say, so the caller must not run the chat.
 */
export async function loadKnowledge(tenantId: string): Promise<{ identity: LenderIdentity; knowledge: string } | null> {
  const identity = await findLenderIdentity(tenantId)
  return identity ? { identity, knowledge: await knowledgeFor(tenantId, identity) } : null
}
