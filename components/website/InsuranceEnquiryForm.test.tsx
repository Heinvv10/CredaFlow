import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

vi.mock("@/components/turnstile-widget", () => ({ TurnstileWidget: () => null }))

import { ACME_LENDER } from "@/lib/config/__fixtures__/lender-identity"
import { expectNoOtherLender } from "@/lib/website/__fixtures__/other-lender"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { InsuranceEnquiryForm } from "./InsuranceEnquiryForm"

describe("InsuranceEnquiryForm", () => {
  it("names the configured lender in the POPIA consent and no other", () => {
    const html = renderToStaticMarkup(
      <WebsiteIdentityProvider identity={ACME_LENDER}>
        <InsuranceEnquiryForm />
      </WebsiteIdentityProvider>,
    )
    expect(html).toContain("I agree that Acme Lending may store these details")
    expect(html).toContain("Acme Lending is")
    expectNoOtherLender(html)
  })

  it("refuses to render outside the website shell rather than guess a lender", () => {
    expect(() => renderToStaticMarkup(<InsuranceEnquiryForm />)).toThrow()
  })
})
