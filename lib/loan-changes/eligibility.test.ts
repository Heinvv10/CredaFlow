import { describe, expect, it } from "vitest"
import { changeRefusal, NCA_REFUSAL, type LoanChangeFacts } from "./eligibility"

const facts: LoanChangeFacts = {
  status: "ACTIVE", productActive: true, disclosureRegime: "KEY_FACTS", contractType: "LOAN", assetFinance: false, hasClient: true, deceased: false, interestModel: "REDUCING_BALANCE",
  creditLifePremiums: 0, repaymentMethod: "EFT", debtReview: false, collectionsStage: "NONE", arrangementActive: false, paymentPlanActive: false, mandates: 0, collectionInstructions: 0,
  chargesAccrued: 0, chargesOutstanding: 0, scheduleTies: true,
}

describe("changeRefusal", () => {
  it("allows a live key-facts loan, and a defaulted one", () => {
    expect(changeRefusal(facts, "IN_PLACE")).toBeNull()
    expect(changeRefusal({ ...facts, status: "DEFAULTED" }, "NEW_LOAN")).toBeNull()
  })

  it("refuses every NCA loan, whatever else is true of it", () => {
    expect(changeRefusal({ ...facts, disclosureRegime: "NCA_PASQ" }, "IN_PLACE")).toBe(NCA_REFUSAL)
    expect(changeRefusal({ ...facts, disclosureRegime: "NCA_PASQ" }, "NEW_LOAN")).toBe(NCA_REFUSAL)
  })

  it.each<[string, Partial<LoanChangeFacts>, RegExp]>([
    ["a lease or instalment sale", { contractType: "FINANCE_LEASE" }, /asset-finance/],
    ["a financed asset", { assetFinance: true }, /asset-finance/],
    ["an entity borrower", { hasClient: false }, /person/],
    ["a closed loan", { status: "COMPLETED" }, /active or defaulted/],
    ["a write-off in progress", { status: "PENDING_WRITE_OFF" }, /active or defaulted/],
    ["a deceased borrower", { deceased: true }, /deceased/],
    ["a daily-accrual loan", { interestModel: "DAILY_ACCRUAL" }, /single payment/],
    ["credit life", { creditLifePremiums: 100 }, /credit life/],
    ["a debit order", { repaymentMethod: "DEBIT_ORDER" }, /debit order/],
    // No method recorded (a loan the demo seed booked on a DRAFT application): still refused, but not called a debit order.
    ["no recorded repayment method", { repaymentMethod: null }, /^This loan's application records no repayment method/],
    ["no recorded repayment method and a live mandate", { repaymentMethod: null, mandates: 1 }, /debit order/],
    ["a live mandate", { mandates: 1 }, /debit order/],
    ["collection instructions", { collectionInstructions: 1 }, /debit order/],
    ["debt review", { debtReview: true }, /debt review/],
    ["an attorney", { collectionsStage: "ATTORNEY_REFERRED" }, /attorney/],
    ["an arrangement", { arrangementActive: true }, /arrangement/],
    ["a plan", { paymentPlanActive: true }, /arrangement/],
  ])("refuses %s in place and into a new loan", (_name, over, reason) => {
    expect(changeRefusal({ ...facts, ...over }, "IN_PLACE")).toMatch(reason)
    expect(changeRefusal({ ...facts, ...over }, "NEW_LOAN")).toMatch(reason)
  })

  it("default charges refuse a change in place, not a refinance, which settles them", () => {
    expect(changeRefusal({ ...facts, chargesAccrued: 500 }, "IN_PLACE")).toMatch(/default charges/)
    expect(changeRefusal({ ...facts, chargesOutstanding: 500 }, "IN_PLACE")).toMatch(/default charges/)
    expect(changeRefusal({ ...facts, chargesAccrued: 500 }, "NEW_LOAN")).toBeNull()
  })

  it("a retired product refuses a new loan, not a change to the one already written on it", () => {
    expect(changeRefusal({ ...facts, productActive: false }, "NEW_LOAN")).toMatch(/no longer offered/)
    expect(changeRefusal({ ...facts, productActive: false }, "IN_PLACE")).toBeNull()
  })

  it("a schedule that does not tie is refused in place", () => {
    expect(changeRefusal({ ...facts, scheduleTies: false }, "IN_PLACE")).toMatch(/does not add up/)
    expect(changeRefusal({ ...facts, scheduleTies: false }, "NEW_LOAN")).toBeNull()
  })
})
