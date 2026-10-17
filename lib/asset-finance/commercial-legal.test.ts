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
  const contractualInterest = result.lawfulSchedule!.reduce((sum, row) => sum + row.interestDue, 0)
  expect(result.interestOutstanding + contractualInterest).toBe(20000)
  expect(result.postings.filter((p) => p.type === "DEFAULT_INTEREST").reduce((sum, p) => sum + p.amount, 0)).toBe(result.interestOutstanding)
})

it("caps contractual arrear interest itself when it already exceeds capital", () => {
  const row = { id: "contractual", dueDate: d("2020-01-01"), principalDue: 10000, interestDue: 20000, feesDue: 0, totalDue: 30000, totalPaid: 0 }
  const result = computeNonNcaCharges({ schedule: [row], receipts: [], interestRatePm: 1, maturityDate: row.dueDate, asOf: d("2021-01-01"), defaultInterestMargin: 0, collectionFeeCents: null })
  expect(result.lawfulSchedule?.[0]).toMatchObject({ interestDue: 10000, totalDue: 20000, contractualInterestDue: 20000 })
  const loan = { principal: 10000, totalInterest: 20000, totalRepayable: 30000, totalPaid: 0, interestRatePm: 1, interestModel: "REDUCING_BALANCE" as const, startDate: d("2019-01-01"), maturityDate: row.dueDate, ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE" }
  expect(currentSettlementAmount({ loan, schedule: [row], asOf: d("2021-01-01") })).toBe(20000)
})

it("does not discount earned contractual interest before any instalment is overdue", () => {
  const row = { id: "ordinary", dueDate: d("2026-12-31"), principalDue: 10000, interestDue: 40000, feesDue: 0, totalDue: 50000, totalPaid: 0 }
  const loan = { principal: 10000, totalInterest: 40000, totalRepayable: 50000, totalPaid: 0, interestRatePm: 1, interestModel: "REDUCING_BALANCE" as const, startDate: d("2025-12-31"), maturityDate: row.dueDate, ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE" }
  const asOf = d("2026-07-01")
  const earned = Math.round(40000 * 182 / 365)
  expect(currentSettlementAmount({ loan, schedule: [row], asOf })).toBe(10000 + earned)
  const result = computeNonNcaCharges({ startDate: loan.startDate, schedule: [row], receipts: [], interestRatePm: 1, maturityDate: row.dueDate, asOf, defaultInterestMargin: null, collectionFeeCents: null })
  expect(result.lawfulSchedule?.[0].interestDue).toBe(40000)
})

it("resumes only new daily interest after a partial receipt releases common-law headroom", () => {
  const input = { schedule: [{ dueDate: d("2020-01-01"), principalDue: 10000, interestDue: 0, feesDue: 0, totalDue: 10000 }], interestRatePm: 1, maturityDate: d("2020-01-01"), defaultInterestMargin: 0, collectionFeeCents: null }
  const receipts = [{ id: "partial", amount: 5000, receivedAt: d("2021-01-01") }]
  const atPayment = computeNonNcaCharges({ ...input, receipts, asOf: d("2021-01-01") })
  const nextDay = computeNonNcaCharges({ ...input, receipts, asOf: d("2021-01-02") })
  expect(atPayment.receiptSplits[0].toDefaultInterest).toBe(5000)
  expect(atPayment.interestOutstanding).toBe(5000)
  expect(nextDay.interestOutstanding).toBeGreaterThan(5000)
  expect(nextDay.interestOutstanding).toBe(5329)
  expect(nextDay.interestAccrued).toBe(10329)
})

it.each([-1, 0, 1])("stop boundary preserves the ceiling with two receipts valued %s days from the stop", (offset) => {
  const stop = d("2021-01-01")
  const receivedAt = new Date(stop.getTime() + offset * 86400000)
  const schedule = [
    { dueDate: d("2020-01-01"), principalDue: 5000, interestDue: 1000, feesDue: 0, totalDue: 6000 },
    { dueDate: d("2025-01-01"), principalDue: 5000, interestDue: 20000, feesDue: 0, totalDue: 25000 },
  ]
  const receipts = ["first", "second"].map((id) => ({ id, amount: 2500, receivedAt }))
  const result = computeNonNcaCharges({ startDate: d("2019-01-01"), schedule, receipts, interestRatePm: 1,
    maturityDate: d("2025-01-01"), asOf: d("2026-01-01"), defaultInterestMargin: 0, collectionFeeCents: null,
    stoppedCharges: { at: stop, receipts: receipts.map((r) => ({ id: r.id, defaultInterestAllocated: offset <= 0 ? 2500 : 0, chargeFeesAllocated: 0 })) },
  })
  const rows = result.lawfulSchedule!
  const unpaidInterest = rows.reduce((sum, row, i) => sum + Math.max(0, row.interestDue - result.scheduleRows[i].paid), 0)
  const capital = rows.reduce((sum, row, i) => sum + Math.min(schedule[i].principalDue, Math.max(0, row.totalDue - result.scheduleRows[i].paid)), 0)
  expect(result.interestOutstanding).toBe(0)
  expect(result.feesOutstanding).toBe(0)
  expect(unpaidInterest).toBeLessThanOrEqual(capital)
  expect(result.receiptSplits.reduce((sum, r) => sum + r.toDefaultInterest, 0)).toBe(offset <= 0 ? 5000 : 0)
})
