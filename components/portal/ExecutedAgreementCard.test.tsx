import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ExecutedAgreementCard } from "./ExecutedAgreementCard"

describe("ExecutedAgreementCard", () => {
  it("renders nothing before countersignature", () => {
    expect(
      renderToStaticMarkup(<ExecutedAgreementCard agreementExecutedDocumentId={null} />),
    ).toBe("")
  })

  it("links to the logged document download route once executed", () => {
    const html = renderToStaticMarkup(
      <ExecutedAgreementCard agreementExecutedDocumentId="doc-1" />,
    )
    expect(html).toContain('href="/api/documents/doc-1/view?download=1"')
    expect(html).toContain("Download signed agreement")
    expect(html).not.toContain("signing-packet")
  })
})
