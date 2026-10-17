import { describe, expect, it } from "vitest"
import { computeNonNcaCharges } from "./non-nca-charges"
import { currentSettlementAmount, projectReceipt } from "@/lib/loan/settlement"
import { portalSignatureProblem } from "./signing-esign"

const d = (s: string) => new Date(`${s}T12:00:00+02:00`)
describe("commercial legal safeguards", () => {
  it("requires wet ink for every suretyship", () => {
    expect(portalSignatureProblem("SURETYSHIP")).toMatch(/wet ink/i)
    expect(portalSignatureProblem("AGREEMENT")).toBeNull()
  })
  it("caps unpaid default plus overdue contractual interest at unpaid capital", () => {
    const result = computeNonNcaCharges({
      schedule: [{ dueDate: d("2020-01-01"), principalDue: 10000, interestDue: 1000, feesDue: 0, totalDue: 11000 }],
      receipts: [], interestRatePm: 1, maturityDate: d("2020-01-01"), asOf: d("2026-01-01"),
      defaultInterestMargin: 0, collectionFeeCents: null,
    })
    expect(result.interestOutstanding).toBe(9000)
  })
})

it("commercial settlement rebates future interest and reprices its settling receipt", () => {
  const loan = { principal: 20000, totalInterest: 2000, totalRepayable: 22000, totalPaid: 0,
    interestRatePm: 0.01, interestModel: "REDUCING_BALANCE" as const,
    startDate: d("2026-01-01"), maturityDate: d("2026-03-01"), ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE" }
  const schedule = ["2026-02-01", "2026-03-01"].map((date, i) => ({
    id: String(i), dueDate: d(date), principalDue: 10000, interestDue: 1000, feesDue: 0, totalDue: 11000, totalPaid: 0,
  }))
  const args = { loan, schedule, asOf: d("2026-02-15") }
  expect(currentSettlementAmount(args)).toBe(21500)
  const paid = projectReceipt({ ...args, amount: 21500 })
  expect(paid.isCompleted).toBe(true)
  expect(paid.totalRepayable).toBe(21500)
  expect(paid.interestRebate).toBe(500)
})

import { parseSuretyConsent } from "./surety-consent"
import { instalmentSaleClauses } from "./documents/wording/instalment-sale"
import { syntheticDealDocumentData } from "./documents/synthetic-deal.fixture"

it("requires a spouse, distinct witnesses and uploaded consent for in-community sureties", () => {
  expect(parseSuretyConsent({ maritalRegime: "IN_COMMUNITY" })).toMatchObject({ maritalRegime: "IN_COMMUNITY", evidenceDocumentId: null })
  expect(parseSuretyConsent({ maritalRegime: "IN_COMMUNITY", spouseName: "TEST Spouse", witnessOne: "TEST One", witnessTwo: "test one", evidenceDocumentId: "doc" })).toMatch(/two distinct witnesses/)
  expect(parseSuretyConsent({ maritalRegime: "UNMARRIED" })).toMatchObject({ maritalRegime: "UNMARRIED" })
})
it("CPA sale preserves statutory goods remedies and prominently draws attention to indemnity and risk", () => {
  const clauses = instalmentSaleClauses(syntheticDealDocumentData({ isaCpaApplies: true }))
  expect(clauses[0].text).toContain("repair, replacement or refund")
  expect(clauses[1].text).toContain("NOTICE UNDER SECTION 49")
  expect(clauses[1].text).toContain("gross negligence")
  const commercial = instalmentSaleClauses(syntheticDealDocumentData({ isaCpaApplies: false }))
  expect(commercial[1].text).not.toContain("NOTICE UNDER SECTION 49")
})

it("a later contractual-interest due date cannot push total unpaid interest above the common-law ceiling", () => {
  const result = computeNonNcaCharges({
    schedule: ["2020-01-01", "2021-01-01"].map((date) => ({ dueDate: d(date), principalDue: 10000, interestDue: 1000, feesDue: 0, totalDue: 11000 })),
    receipts: [], interestRatePm: 1, maturityDate: d("2021-01-01"), asOf: d("2026-01-01"),
    defaultInterestMargin: 0, collectionFeeCents: null,
  })
  expect(result.interestOutstanding).toBe(18000)
  expect(result.postings.filter((p) => p.type === "DEFAULT_INTEREST").reduce((sum, p) => sum + p.amount, 0)).toBe(18000)
})
