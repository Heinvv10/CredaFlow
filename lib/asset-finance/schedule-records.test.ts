import { describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import {
  capitalisedInterestCents,
  deriveWeights,
  dueDateInstant,
  modalPositive,
  toScheduleRecord,
} from "./schedule-records"
import { BASE, PATTERNS, solvePattern } from "./__tests__/schedule-fixtures"

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0)

describe("toScheduleRecord: the stored representation", () => {
  describe.each(Object.entries(PATTERNS))("%s", (_name, weights) => {
    const result = solvePattern(weights)
    const records = result.rows.map(toScheduleRecord)
    const last = records.length - 1

    it("stores no negative amount, never more interest than the payment, and total = principal + interest", () => {
      records.forEach((record, i) => {
        const payment = record.totalDue - (i === last ? BASE.balloonCents : 0)
        expect(record.principalDue).toBeGreaterThanOrEqual(0)
        expect(record.interestDue).toBeGreaterThanOrEqual(0)
        expect(record.interestDue).toBeLessThanOrEqual(payment)
        expect(record.totalDue).toBe(record.principalDue + record.interestDue)
        expect([record.feesDue, record.creditLifePremiumDue]).toEqual([0, 0])
        expect(record.installmentNo).toBe(i + 1)
      })
    })

    it("reconciles: Σ principal = F + C, Σ interest = I − C, Σ total = F + I (the Loan totals)", () => {
      const capitalised = sum(result.rows.map(capitalisedInterestCents))
      expect(sum(records.map((r) => r.principalDue))).toBe(result.financedAmountCents + capitalised)
      expect(sum(records.map((r) => r.interestDue))).toBe(result.totalInterestCents - capitalised)
      expect(sum(records.map((r) => r.totalDue))).toBe(result.financedAmountCents + result.totalInterestCents)
      expect(result.totalPayableCents).toBe(result.financedAmountCents + result.totalInterestCents)
    })
  })

  it("stores a skip row as nothing due and capitalises its whole interest", () => {
    const result = solvePattern(PATTERNS.SKIP_N)
    for (const row of result.rows.slice(0, 3)) {
      expect(row.interestCents).toBeGreaterThan(0)
      expect(toScheduleRecord(row)).toMatchObject({ principalDue: 0, interestDue: 0, totalDue: 0 })
      expect(capitalisedInterestCents(row)).toBe(row.interestCents)
    }
    // The capitalised interest is repaid as principal by the later rows.
    const capitalised = sum(result.rows.map(capitalisedInterestCents))
    expect(capitalised).toBeGreaterThan(0)
    const laterPrincipal = sum(result.rows.slice(3).map((r) => toScheduleRecord(r).principalDue))
    expect(laterPrincipal).toBe(result.financedAmountCents + capitalised)
  })

  it("stores a low-weight row as its payment, all interest, and capitalises the rest", () => {
    const result = solvePattern(PATTERNS.SEASONAL)
    const short = result.rows.filter((row) => row.weight === 0.2 && row.totalCents < row.interestCents)
    expect(short.length).toBeGreaterThan(3)
    for (const row of short) {
      const payment = row.totalCents - row.balloonCents
      expect(payment).toBeGreaterThan(0)
      expect(toScheduleRecord(row)).toMatchObject({ principalDue: 0, interestDue: payment, totalDue: payment })
      expect(capitalisedInterestCents(row)).toBe(row.interestCents - payment)
    }
    // A low-weight row that does cover its interest stores the usual split.
    const covered = result.rows.find((row) => row.weight === 0.2 && row.totalCents >= row.interestCents)
    if (!covered) throw new Error("fixture: expected a covered off-season row")
    expect(toScheduleRecord(covered)).toMatchObject({ interestDue: covered.interestCents, principalDue: covered.principalCents })
    expect(capitalisedInterestCents(covered)).toBe(0)
  })

  it("stores the balloon as capital on the last row; a monthly schedule capitalises nothing", () => {
    const result = solvePattern(PATTERNS.MONTHLY)
    const records = result.rows.map(toScheduleRecord)
    expect(records[59].principalDue).toBe(result.rows[59].principalCents + BASE.balloonCents)
    expect(sum(result.rows.map(capitalisedInterestCents))).toBe(0)
    expect(sum(records.map((r) => r.principalDue))).toBe(result.financedAmountCents)
  })

  it("stores a due date at SAST midnight, which reads back as the same calendar day", () => {
    const result = solvePattern(PATTERNS.MONTHLY)
    expect(dueDateInstant("2027-01-15").toISOString()).toBe("2027-01-14T22:00:00.000Z")
    expect(result.rows.map(toScheduleRecord).map((r) => sastCalendarDate(r.dueDate))).toEqual(result.rows.map((r) => r.dueDate))
  })
})

describe("modalPositive", () => {
  it("takes the most common positive value, the smallest on a tie, ignoring zeros", () => {
    expect(modalPositive([0, 0, 0, 500, 500, 300])).toBe(500)
    expect(modalPositive([700, 300, 700, 300])).toBe(300)
    expect(modalPositive([0, 0])).toBeNull()
  })
})

describe("deriveWeights", () => {
  it("snaps a weight to 4 decimals when that reproduces the stored round(R × w) payment", () => {
    // R = 2 183 357: 1.15 × R = 2 510 860.55 → stored 2 510 861; 0.5 × R → 1 091 679 (rounded up from .5)
    expect(deriveWeights([2_183_357, 0, 2_510_861, 1_091_679, 2_183_357], 2_183_357, 60)).toEqual([1, 0, 1.15, 0.5, 1])
  })

  it("keeps the raw ratio when no 4-decimal weight reproduces the payment", () => {
    const third = Math.round(2_183_357 / 3) // 727 786
    const [w] = deriveWeights([third, 2_183_357], 2_183_357, 60)
    expect(w).toBe(third / 2_183_357)
    expect(Math.round(2_183_357 * w)).toBe(third)
  })

  it("lets the final row carry the solver's residue of up to one cent per schedule row", () => {
    expect(deriveWeights([2_183_357, 2_183_357 + 37], 2_183_357, 60)).toEqual([1, 1])
    expect(deriveWeights([2_183_357, 2_183_357 + 61], 2_183_357, 60)[1]).toBe((2_183_357 + 61) / 2_183_357)
  })
})
