import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { CLEAR_REASON_PLACEHOLDER, Evidence } from "./CreditChecksPanel"
import { CLEAR_REASON_MIN_LENGTH } from "@/lib/credit-checks/policy"

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
    expect(html).toContain("Both come from the client&#x27;s file")
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

describe("credit-check clear reason minimum", () => {
  // Fair Score audit 2026-10-16: placeholder said 15, the counter another number.
  it("states the policy minimum in the placeholder, as the counter does", () => {
    expect(CLEAR_REASON_PLACEHOLDER).toContain(`at least ${CLEAR_REASON_MIN_LENGTH} characters`)
  })
})
