import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { applyLivePricing } from "@/lib/public-loan-products"
import { HomePage } from "@/components/website/HomePage"
import Footer from "@/components/website/Footer"
import { RegulatoryBand } from "@/components/website/RegulatoryBand"
import { homeFaqs } from "@/app/(website)/site/home-faqs"
import { regulatoryFaqs } from "@/app/(website)/site/regulatory-information/faqs"
import { organizationLd } from "@/lib/seo/jsonld"
import { buildKnowledge } from "@/lib/website-chat/knowledge"

// Fair Score audit goal §2a.2: no FAIS/FSP claim anywhere unless the lender
// holds an FSP number. Every public surface that prints one is rendered here
// for a lender without, and for the same lender with, an FSP number.
const NO_FSP = { ...ACME_LENDER, fspNumber: null, fscaAuthorisationDate: "2026-02-27" }
const WITH_FSP = { ...ACME_LENDER, fscaAuthorisationDate: "2026-02-27" }
const FSP_CLAIM = /\bFSP\b|FAIS[- ]authori|FAIS authorised|financial services provider|Financial Services Provider|FSCA authorisation/i

const PRODUCTS = applyLivePricing({
  personal: {
    interestRatePm: 3, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.15, initiationFeeMax: 605000,
    monthlyServiceFee: 6900, minAmount: 200000, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800,
  },
}).filter((p) => p.code === "personal")

const surfaces: Array<[string, (identity: typeof WITH_FSP | typeof NO_FSP) => string]> = [
  ["home page", (identity) => renderToStaticMarkup(<HomePage identity={identity} products={PRODUCTS} />)],
  ["home FAQs", (identity) => JSON.stringify(homeFaqs(identity, PRODUCTS))],
  ["footer", (identity) => renderToStaticMarkup(<Footer identity={identity} />)],
  ["regulatory band", (identity) => renderToStaticMarkup(<RegulatoryBand identity={identity} />)],
  ["regulatory FAQs", (identity) => JSON.stringify(regulatoryFaqs(identity))],
  ["organisation JSON-LD", (identity) => JSON.stringify(organizationLd(identity))],
  ["website chat knowledge", (identity) => buildKnowledge({ identity, products: PRODUCTS, insurance: [] })],
]

describe.each(surfaces)("%s", (_name, render) => {
  it("makes no FSP or FAIS claim for a lender without an FSP number", () => {
    expect(render(NO_FSP)).not.toMatch(FSP_CLAIM)
  })

  it("still prints the FSP number for a lender that holds one", () => {
    expect(render(WITH_FSP)).toContain("12345")
  })
})

describe("links to the insurance pages", () => {
  it("are left out without an FSP number (the pages 404)", () => {
    expect(renderToStaticMarkup(<HomePage identity={NO_FSP} products={PRODUCTS} />)).not.toContain('href="/site/products/insurance"')
    expect(renderToStaticMarkup(<Footer identity={NO_FSP} />)).not.toContain('href="/site/products/insurance"')
    expect(renderToStaticMarkup(<Footer identity={WITH_FSP} />)).toContain('href="/site/products/insurance"')
  })
})
