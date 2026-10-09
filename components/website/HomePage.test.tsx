import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { applyLivePricing } from "@/lib/public-loan-products"
import { homeFaqs } from "@/app/(website)/site/home-faqs"
import { HomePage } from "./HomePage"

// One tenant product (personal), with its own live range.
const PERSONAL_ONLY = applyLivePricing({
  personal: {
    interestRatePm: 3, interestModel: "REDUCING_BALANCE", initiationFeePct: 0.15, initiationFeeMax: 605000,
    monthlyServiceFee: 6900, minAmount: 200000, maxAmount: 7500000, minTermDays: 90, maxTermDays: 1800,
  },
}).filter((p) => p.code === "personal")

describe("home page", () => {
  it("prints the tenant's identity and only the products it offers", () => {
    const html = renderToStaticMarkup(<HomePage identity={ACME_LENDER} products={PERSONAL_ONLY} />)
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).toContain("NCRCP99999")
    expect(html).toContain("FSP 12345")
    expect(html).toContain("Personal loan")
    expect(html).toContain("R75")
    expect(html).not.toContain("Purchase order funding")
    expect(html).not.toContain("Invoice discounting")
    expect(html).not.toContain("Short-term loan")
    expectNoOtherLender(html)
  })

  it("shows no product cards when the tenant has no loan products", () => {
    const html = renderToStaticMarkup(<HomePage identity={ACME_LENDER} products={[]} />)
    expect(html).not.toContain("Personal loan")
    expectNoOtherLender(html)
  })

  it("names the head office city only when the tenant has set one", () => {
    expect(JSON.stringify(homeFaqs(ACME_LENDER, PERSONAL_ONLY))).not.toMatch(/head office in/)
    expect(JSON.stringify(homeFaqs({ ...ACME_LENDER, headOfficeCity: "Sandton" }, PERSONAL_ONLY))).toMatch(/head office in Sandton/)
  })

  it("answers its FAQs from the identity and products, naming no other lender", () => {
    const faqs = JSON.stringify(homeFaqs(ACME_LENDER, PERSONAL_ONLY))
    expect(faqs).toContain("Acme Lending (Pty) Ltd")
    expect(faqs).toContain("NCRCP99999")
    expect(faqs).toContain("personal loan")
    expectNoOtherLender(faqs)
  })
})
