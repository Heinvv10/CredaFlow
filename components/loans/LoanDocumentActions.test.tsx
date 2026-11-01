import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { LoanDocumentActions } from "./LoanDocumentActions"

describe("LoanDocumentActions", () => {
  it("offers the debit mandate unless the loan has none (a key-facts loan is repaid by EFT)", () => {
    expect(renderToStaticMarkup(<LoanDocumentActions loanId="l1" showSection129={false} />)).toContain("Debit Mandate Draft")
    const keyFacts = renderToStaticMarkup(<LoanDocumentActions loanId="l1" showSection129={false} debitMandate={false} />)
    expect(keyFacts).not.toContain("debit-mandate")
    expect(keyFacts).toContain("Statement")
  })

  // #147 review: after a refresh the loan page must still say the notice was simulated.
  it("labels a simulated notice", () => {
    expect(renderToStaticMarkup(<LoanDocumentActions loanId="l1" showSection129 section129Simulated />)).toContain("S129 Notice (simulated, not sent)")
    expect(renderToStaticMarkup(<LoanDocumentActions loanId="l1" showSection129 />)).not.toContain("simulated")
  })
})
