import { renderToStaticMarkup } from "react-dom/server"
import { describe, it, expect, vi } from "vitest"
import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"

vi.mock("@/lib/website/identity", () => ({ getWebsiteIdentity: vi.fn(async () => ACME_LENDER) }))
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/site/calculators",
}))

import CalculatorsPage, { generateMetadata } from "./page"
import { CALCULATORS_FAQS } from "./faqs"

describe("calculators page", () => {
  it("prints the tenant's legal name and NCR number in the disclosure, nobody else", async () => {
    const html = renderToStaticMarkup(await CalculatorsPage())
    expect(html).toContain("Acme Lending (Pty) Ltd")
    expect(html).toContain("NCRCP99999")
    expect(html).toContain("Acme Lending Loan Calculators")
    expectNoOtherLender(html)
  })

  it("emits tenant metadata", async () => {
    const meta = JSON.stringify(await generateMetadata())
    expect(meta).toContain("Acme Lending")
    expectNoOtherLender(meta)
  })

  it("FAQs are free of other lenders", () => {
    expectNoOtherLender(JSON.stringify(CALCULATORS_FAQS))
  })
})
