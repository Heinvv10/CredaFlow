import { describe, it, expect } from "vitest"
import { refFor, type LoanOption } from "./ManualPaymentForm"

const loans: LoanOption[] = [
  { id: "l1", reference: "LN-0001", outstandingPrincipal: 500000, nextInstallment: 150000 },
  { id: "l2", reference: "LN-0002", outstandingPrincipal: 800000, nextInstallment: null },
]

describe("refFor — Bank Reference pre-fill resolves the selected loan's reference", () => {
  // The Bank Reference field pre-fills with Loan.reference — the token the
  // bank-sync reconciler EXACT-matches on — so a client submitting a manual
  // payment notification quotes the correct reference by default.
  it("returns the reference of the selected loan", () => {
    expect(refFor("l1", loans)).toBe("LN-0001")
    expect(refFor("l2", loans)).toBe("LN-0002")
  })

  it("returns an empty string for an unknown loan id", () => {
    expect(refFor("nope", loans)).toBe("")
  })

  it("returns an empty string when there are no loans", () => {
    expect(refFor("", [])).toBe("")
  })
})
