import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AgreementSignedPanel } from "./PortalAgreementClient"

/**
 * The screen the borrower lands on straight after signing in the portal.
 *
 * At that moment only the borrower has signed. Nothing carrying a signature
 * exists yet: the executed agreement is minted when the credit provider
 * countersigns. The signing packet URL serves the UNSIGNED PASQ and agreement,
 * so it must never be offered here as the agreement the borrower signed.
 */

const NOT_YET = "Your signed copy will be available to download once we countersign your agreement."

function render(props: { executed: string | null; mandateRequired?: boolean }) {
  return renderToStaticMarkup(
    <AgreementSignedPanel
      applicationId="app-1"
      agreementExecutedDocumentId={props.executed}
      mandateRequired={props.mandateRequired ?? true}
    />,
  )
}

describe("portal agreement signed panel — before countersignature", () => {
  it("offers no download and says when the signed copy arrives", () => {
    const html = render({ executed: null })
    expect(html).toContain(NOT_YET)
    expect(html).not.toContain("signing-packet")
    expect(html).not.toContain("Download")
  })

  it("keeps the way on to repayment set-up", () => {
    const html = render({ executed: null })
    expect(html).toContain('href="/portal/mandate/app-1"')
    expect(html).toContain("Set up repayment")
  })

  it("keeps the way on to the application when no mandate is needed", () => {
    const html = render({ executed: null, mandateRequired: false })
    expect(html).toContain('href="/portal/applications/app-1"')
    expect(html).toContain("View application")
  })
})

describe("portal agreement signed panel — after countersignature", () => {
  it("links the executed document, labelled as the signed agreement", () => {
    const html = render({ executed: "executed-doc" })
    expect(html).toContain('href="/api/documents/executed-doc/view?download=1"')
    expect(html).toContain("Download signed agreement")
    expect(html).not.toContain("signing-packet")
    expect(html).not.toContain(NOT_YET)
  })
})
