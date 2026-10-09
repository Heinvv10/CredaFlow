import { describe, it, expect } from "vitest"
import { summariseUpload } from "./upload-summary"

describe("summariseUpload", () => {
  it("reports lines imported and the count left to review", () => {
    expect(summariseUpload({ lineCount: 10, newTxnCount: 4, autoApplied: 0, deduplicated: false })).toBe(
      "Imported 10 lines, 4 new transactions to review.",
    )
  })

  it("says nothing was added for a re-uploaded file", () => {
    expect(summariseUpload({ lineCount: 10, newTxnCount: 0, autoApplied: 0, deduplicated: true })).toBe(
      "Already imported — this exact file was uploaded before, so nothing was added.",
    )
  })

  // The bug this guards: newTxnCount INCLUDES auto-applied rows, so reporting it
  // as "to review" would tell an operator to expect 4 rows when 1 is waiting —
  // and would never mention that 3 payments were posted against real loans.
  it("excludes auto-applied rows from the review count and says money was posted", () => {
    const text = summariseUpload({ lineCount: 10, newTxnCount: 4, autoApplied: 3, deduplicated: false })

    expect(text).toContain("1 new transaction to review")
    expect(text).not.toContain("4 new transactions to review")
    expect(text).toContain("3 high-confidence matches auto-applied as payments")
    expect(text).toContain("check the loan balances")
  })

  it("singularises a lone auto-applied payment", () => {
    const text = summariseUpload({ lineCount: 2, newTxnCount: 1, autoApplied: 1, deduplicated: false })

    expect(text).toContain("0 new transactions to review")
    expect(text).toContain("1 high-confidence match auto-applied as a payment")
  })
})
