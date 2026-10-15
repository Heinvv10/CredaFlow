import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Evidence } from "./CreditChecksPanel"

const flag = {
  id: "f1", check: "MANUAL_REVIEW" as const, code: "FIRST_ROW_UNVERIFIED", status: "OPEN" as const, summary: "First row.",
  raisedAt: "2026-10-13T08:00:00Z", clearedAt: null, clearReason: null, clearedByName: null,
  documentId: "doc-1", documentName: "july.pdf", pages: [], rows: [], chainedWith: null,
}

describe("CreditChecksPanel evidence", () => {
  it("names the adjacent statement a boundary row agrees with, as something to compare, not a verdict", () => {
    const html = renderToStaticMarkup(<Evidence flag={{ ...flag, chainedWith: {
      documentId: "doc-2", documentName: "june.pdf", periodStart: "2026-06-01", periodEnd: "2026-06-30", relation: "previous", balanceCents: 580_000,
    } }} />)
    expect(html).toContain("Agrees with the previous statement")
    expect(html).toContain('href="/api/documents/doc-2/view"')
    expect(html).toContain("june.pdf (2026-06-01 to 2026-06-30)")
    expect(html).toContain("closes at R 5 800.00")
    expect(html).toContain("Both were uploaded by the applicant")
  })

  it("says the next statement opens there, for a last row", () => {
    const html = renderToStaticMarkup(<Evidence flag={{ ...flag, code: "LAST_ROW_UNVERIFIED", chainedWith: {
      documentId: "doc-3", documentName: null, periodStart: "2026-08-01", periodEnd: "2026-08-31", relation: "next", balanceCents: -1_250,
    } }} />)
    expect(html).toContain("Agrees with the next statement")
    expect(html).toContain("opens at -R 12.50")
  })

  it("says nothing about agreement when no adjacent statement agrees", () => {
    expect(renderToStaticMarkup(<Evidence flag={flag} />)).not.toContain("Agrees with")
  })
})
