import { describe, expect, it } from "vitest"
import { restateSettledSchedule } from "./reprice-restatement"
import { BASE, PATTERNS, solvePattern, storedRows } from "./__tests__/schedule-fixtures"
import { oracleDealFromInput, oracleReplay } from "./__tests__/structure-oracle"

const booked = solvePattern(PATTERNS.MONTHLY)
const paid = 11
const stored = storedRows(booked, paid).map((row, i) => ({ ...row, assetFinanceOpeningBalanceCents: booked.rows[i].openingBalanceCents }))
describe("late reference-rate correction", () => {
  it.each([0.15, 0.10])("restates paid-period allocation at %s from its effective date, preserving cash", (annualRate) => {
    const effectiveDate = booked.rows[9].dueDate
    const path = [...BASE.ratePath, { effectiveDate, annualRate }]
    const result = restateSettledSchedule({ stored, paidThroughIndex: paid, originalClosingBalanceCents: booked.rows[paid].closingBalanceCents, startDate: BASE.startDate, oldPath: BASE.ratePath, newPath: path, effectiveDate })
    const truth = oracleReplay(oracleDealFromInput({ ...BASE, weights: PATTERNS.MONTHLY, ratePath: path }), booked.rows.map((row) => row.totalCents - row.balloonCents))
    expect(result.closingBalanceCents).toBe(truth[paid].balanceAfterPaymentCents)
    expect(Math.sign(result.adjustmentCents)).toBe(annualRate > BASE.ratePath[0].annualRate ? 1 : -1)
    for (const row of result.rows) {
      expect(row.totalCents).toBe(booked.rows[row.index].totalCents)
      expect(row.interestCents).toBe(truth[row.index].interestCents)
    }
    expect(result.rows[0].index).toBe(9)
  })
  it("includes the effective day even when it was the last paid due date", () => {
    const effectiveDate = booked.rows[paid].dueDate
    const result = restateSettledSchedule({ stored, paidThroughIndex: paid, originalClosingBalanceCents: booked.rows[paid].closingBalanceCents, startDate: BASE.startDate, oldPath: BASE.ratePath, newPath: [...BASE.ratePath, { effectiveDate, annualRate: 0.15 }], effectiveDate })
    expect(result.rows).toHaveLength(1)
    expect(result.adjustmentCents).toBeGreaterThan(0)
  })
  it("reconstructs legacy opening balances exactly instead of skipping the correction", () => {
    const effectiveDate = booked.rows[9].dueDate
    const input = { stored, paidThroughIndex: paid, originalClosingBalanceCents: booked.rows[paid].closingBalanceCents, startDate: BASE.startDate, oldPath: BASE.ratePath, newPath: [...BASE.ratePath, { effectiveDate, annualRate: 0.15 }], effectiveDate }
    expect(restateSettledSchedule({ ...input, stored: stored.map(({ assetFinanceOpeningBalanceCents: _opening, ...row }) => row) })).toEqual(restateSettledSchedule(input))
  })
  it("retains a customer credit after capital is paid off without charging interest on the credit", () => {
    const all = storedRows(booked, booked.rows.length - 1).map((row, i) => ({ ...row, assetFinanceOpeningBalanceCents: booked.rows[i].openingBalanceCents }))
    const result = restateSettledSchedule({ stored: all, paidThroughIndex: all.length - 1, originalClosingBalanceCents: 0, startDate: BASE.startDate, oldPath: BASE.ratePath, newPath: [...BASE.ratePath, { effectiveDate: booked.rows[9].dueDate, annualRate: 0.01 }], effectiveDate: booked.rows[9].dueDate })
    expect(result.closingBalanceCents).toBeLessThan(0)
    expect(result.rows.every((row) => row.interestCents >= 0)).toBe(true)
  })

})
