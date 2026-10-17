import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { PortalDebitMandateClient, bankOption } from "./PortalDebitMandateClient"

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

// Fair Score acceptance (2026-10-17): the client record held "NEDBANK" but the
// picker lists "Nedbank", so the select fell back to the placeholder.
describe("bankOption", () => {
  it.each([
    ["NEDBANK", "Nedbank"],
    ["FIRSTRAND BANK LIMITED t/a FNB", "FNB (First National Bank)"],
    ["Capitec Bank Limited", "Capitec Bank"],
    ["Some Unknown Bank", ""],
    ["", ""],
    ["   ", ""],
  ])("maps %j to %j", (stored, option) => {
    expect(bankOption(stored)).toBe(option)
  })

  it("pre-selects the matching option in the rendered picker", () => {
    const html = renderToStaticMarkup(
      <PortalDebitMandateClient {...props} initialBankDetails={{ ...props.initialBankDetails, bankName: "NEDBANK" }} />,
    )
    expect(html).toContain("<option selected=\"\">Nedbank</option>")
  })

  it("never selects a wrong bank for one it does not list", () => {
    const html = renderToStaticMarkup(
      <PortalDebitMandateClient {...props} initialBankDetails={{ ...props.initialBankDetails, bankName: "Some Unknown Bank" }} />,
    )
    expect(html).toContain('<option value="" selected="">Select your bank</option>')
  })
})
