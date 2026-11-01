import { describe, expect, it } from "vitest"
import { InvalidPayloadError } from "@/lib/maker-checker/errors"
import { parseLoanChangePayload } from "./payload"
import { LOAN_CHANGE_TYPES } from "./types"

const base = { loanId: "l1", reason: "Borrower lost overtime", signedDocumentId: "doc1" }
const problems = (raw: unknown) => {
  try {
    parseLoanChangePayload(raw)
  } catch (error) {
    if (error instanceof InvalidPayloadError) return error.problems
    throw error
  }
  return []
}
const VALID = {
  RESCHEDULE: { firstDueDate: "2027-01-31" }, RESTRUCTURE: { instalments: 12 }, PAYMENT_HOLIDAY: { holidayInstalments: 2 }, RATE_CHANGE: { interestRatePm: 0.03 }, TERM_CHANGE: { instalments: 12 },
  TOP_UP: { newMoneyCents: 100, payoutReference: "EFT-1", instalments: 12 }, REFINANCE: { instalments: 12 }, CONSOLIDATION: { otherLoanIds: ["l2"], instalments: 12 },
}

describe("parseLoanChangePayload", () => {
  it.each(LOAN_CHANGE_TYPES)("accepts a valid %s and keeps its fields", (type) => {
    expect(parseLoanChangePayload({ type, ...base, ...VALID[type] })).toEqual({ type, ...base, ...VALID[type] })
  })

  it("refuses a type it does not know, and a field its type does not take", () => {
    expect(problems({ type: "WAIVE", ...base })).toHaveLength(1)
    expect(problems({ type: "RATE_CHANGE", ...base, interestRatePm: 0.03, instalments: 4 }).join()).toMatch(/instalments/)
  })

  it("needs the reason, the signed document and the type's own fields", () => {
    expect(problems({ type: "RATE_CHANGE", loanId: "l1", interestRatePm: 0.03 }).join()).toMatch(/reason[\s\S]*signedDocumentId/)
    expect(problems({ type: "TOP_UP", ...base, instalments: 3 }).join()).toMatch(/newMoneyCents[\s\S]*payoutReference/)
    expect(problems({ type: "RESTRUCTURE", ...base }).join()).toMatch(/rate, the term or both/)
  })

  it.each([[-0.01], [1], [Number.NaN], ["0.03"]])("refuses the rate %s", (rate) => {
    expect(problems({ type: "RATE_CHANGE", ...base, interestRatePm: rate })).toHaveLength(1)
  })

  it.each([[0], [1.5], [521]])("refuses %s instalments", (n) => {
    expect(problems({ type: "TERM_CHANGE", ...base, instalments: n })).toHaveLength(1)
  })

  it("refuses a consolidation of nothing, of the loan itself, or of a loan twice", () => {
    for (const otherLoanIds of [[], ["l1"], ["l2", "l2"]]) expect(problems({ type: "CONSOLIDATION", ...base, otherLoanIds, instalments: 6 })).toHaveLength(1)
  })

  it("refuses money that is not whole cents, and a bad date", () => {
    expect(problems({ type: "TOP_UP", ...base, newMoneyCents: 10.5, payoutReference: "EFT-1", instalments: 6 })).toHaveLength(1)
    expect(problems({ type: "RESCHEDULE", ...base, firstDueDate: "31/01/2027" })).toHaveLength(1)
  })
})
