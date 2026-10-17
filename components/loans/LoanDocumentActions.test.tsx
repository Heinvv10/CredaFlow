import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LoanDocumentActions } from "./LoanDocumentActions"

describe("LoanDocumentActions", () => {
  // #147 review: after a refresh the loan page must still say the notice was simulated.
  it("labels a simulated notice", () => {
    expect(renderToStaticMarkup(<LoanDocumentActions loanId="l1" showSection129 section129Simulated />)).toContain("S129 Notice (simulated, not sent)")
    expect(renderToStaticMarkup(<LoanDocumentActions loanId="l1" showSection129 />)).not.toContain("simulated")
  })
})
