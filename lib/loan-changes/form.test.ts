import { describe, expect, it } from "vitest"
import { emptyForm, formPayload } from "./form"
import { parseLoanChangePayload } from "./payload"

const base = { reason: "Borrower lost overtime", signedDocumentId: "doc1" }

describe("formPayload", () => {
  it("turns percent into a decimal rate and major units into cents, exactly", () => {
    const payload = formPayload("l1", { ...emptyForm("TOP_UP"), ...base, ratePercent: "3.45", instalments: "12", newMoney: "1234.56", payoutReference: "EFT-1" })
    expect(payload).toMatchObject({ interestRatePm: 0.0345, instalments: 12, newMoneyCents: 123_456, payoutReference: "EFT-1" })
    expect(parseLoanChangePayload(payload)).toMatchObject({ type: "TOP_UP", newMoneyCents: 123_456 })
  })

  it("leaves out what the type does not take, so the parser accepts it", () => {
    const payload = formPayload("l1", { ...emptyForm("RATE_CHANGE"), ...base, ratePercent: "2", instalments: "9", holidayInstalments: "3" })
    expect(payload).toEqual({ type: "RATE_CHANGE", loanId: "l1", ...base, interestRatePm: 0.02 })
    expect(() => parseLoanChangePayload(payload)).not.toThrow()
  })

  it("leaves out an optional rate left blank", () => {
    expect(formPayload("l1", { ...emptyForm("REFINANCE"), ...base, instalments: "6" })).toEqual({ type: "REFINANCE", loanId: "l1", ...base, instalments: 6 })
  })
})
