import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PortalDebitMandateClient } from "./PortalDebitMandateClient"

const props = {
  applicationId: "app-1",
  reference: "APP-TEST-0001",
  clientName: "Synthetic Client",
  initialBankDetails: { bankName: "Nedbank", branchCode: "198765", accountNumber: "1234567890", accountType: "CHEQUE" as const },
  initialDraftSha256: null,
  initiallySigned: false,
}

describe("PortalDebitMandateClient", () => {
  it("explains why the mandate must be signed again after a return to review", () => {
    const html = renderToStaticMarkup(<PortalDebitMandateClient {...props} returnedToReviewOn="16 October 2026" />)
    expect(html).toContain("Why you are signing again")
    expect(html).toContain("On 16 October 2026 we reopened your application for review")
    expect(html).toContain("Nothing will be collected under anything you signed before")
  })

  it("shows no such note otherwise", () => {
    expect(renderToStaticMarkup(<PortalDebitMandateClient {...props} />)).not.toContain("Why you are signing again")
  })
})
