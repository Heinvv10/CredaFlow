import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ValidationBanner } from "./ValidationBanner"

const base = {
  validationResult: null,
  validationMismatch: false,
  validationScore: null,
  extractionStatus: "failed",
  extractionError: null as string | null,
  hasExtractedData: false,
  docType: "BANK_STATEMENT",
  verified: false,
  docId: "doc-1",
}

const render = (props: Partial<typeof base>) =>
  renderToStaticMarkup(<ValidationBanner {...base} {...props} />)

describe("ValidationBanner — failed extraction", () => {
  // Before this branch existed the component returned null for a failed
  // extraction (validationResult is NULL), so an unreadable document looked
  // identical to a clean one and staff verified it by hand.
  it("warns instead of rendering nothing", () => {
    expect(render({})).toContain("Could not be read automatically")
  })

  it("names password protection when that was the cause", () => {
    const html = render({
      extractionError: "PDF conversion failed: Command Line Error: Incorrect password",
    })
    expect(html).toContain("password-protected")
    expect(html).toContain("Re-upload an unlocked copy")
  })

  it("does not invent a password cause for an unrelated failure", () => {
    const html = render({ extractionError: "VLM timed out" })
    expect(html).toContain("Automatic extraction failed")
    expect(html).not.toContain("password-protected")
  })

  // The disbursement gate reads extracted fields off the BANK STATEMENT only.
  it("mentions the disbursement checks for a bank statement", () => {
    expect(render({ docType: "BANK_STATEMENT" }))
      .toContain("will not satisfy the disbursement checks")
  })

  it("does NOT mention payout accounts on a selfie", () => {
    const html = render({ docType: "SELFIE", extractionStatus: "failed" })
    expect(html).toContain("Could not be read automatically")
    expect(html).not.toContain("payout account")
  })

  it("does NOT mention payout accounts on an ID copy", () => {
    expect(render({ docType: "ID_COPY" })).not.toContain("payout account")
  })

  // The upload route marks the status "failed" while STORING extractionResult
  // when validation throws. Saying the document could not be read is false
  // there, and the password hint points at the wrong remedy.
  it("stays silent when extraction succeeded and only validation failed", () => {
    const html = render({
      hasExtractedData: true,
      extractionError: "Client validation failed: password mismatch on record",
    })
    expect(html).not.toContain("Could not be read automatically")
  })
})

// #145 re-review: the validation props are absent for a viewer without the
// loan book. The banner renders no verdict rather than misread the absence.
describe("ValidationBanner — lending read withheld", () => {
  it.each(["failed", "done"])("renders nothing for a %s extraction whose result was withheld", (extractionStatus) => {
    const html = renderToStaticMarkup(
      <ValidationBanner extractionStatus={extractionStatus} extractionError={null} docType="BANK_STATEMENT" verified={false} docId="doc-1" />,
    )
    expect(html).toBe("")
  })

  it("still shows that the document is being read", () => {
    const html = renderToStaticMarkup(
      <ValidationBanner extractionStatus="processing" extractionError={null} docType="BANK_STATEMENT" verified={false} docId="doc-1" />,
    )
    expect(html).toContain("Analysing document")
  })
})

