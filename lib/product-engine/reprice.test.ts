import { describe, expect, it } from "vitest"
import { generateSchedule } from "./schedule"
import { planReprice, type StoredRow } from "./reprice"
import type { RepaymentTerms } from "./types"

const startDate = new Date("2027-01-10T08:00:00+02:00")
const amortising: RepaymentTerms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 }

function rows(terms: RepaymentTerms, principal = 1_200_000, ratePm = 0.02, fee = 6_900): StoredRow[] {
  return generateSchedule({ principalCents: principal, interestRatePm: ratePm, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: fee, startDate, terms }).schedule.map((r, i) => ({
    id: `r${i + 1}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, creditLifePremiumDue: 0, totalDue: r.totalDue, totalPaid: 0, status: "PENDING",
  }))
}
const plan = (stored: StoredRow[], terms: Pick<RepaymentTerms, "frequency" | "structure"> = amortising, over: Partial<Parameters<typeof planReprice>[0]> = {}) =>
  planReprice({ rows: stored, startDate, frequency: terms.frequency, structure: terms.structure, balloonCents: 0, newRatePm: 0.025, effectiveDate: "2027-04-01", today: over.effectiveDate ?? "2027-04-01", ...over })
const paid = (stored: StoredRow[], n: number) => stored.map((r, i) => (i < n ? { ...r, status: "PAID", totalPaid: r.totalDue } : r))
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)

describe("planReprice", () => {
  it("reprices the rows whose period starts on or after the effective date: the period running on that day keeps its amount", () => {
    const stored = rows(amortising)
    const result = plan(stored)!
    // Row 3 (due 10 Apr) is the period from 10 Mar, which started before 1 Apr: kept. Row 4 (due 10 May) starts on 10 Apr: repriced.
    expect(result.updates.map((u) => u.id)).toEqual(stored.slice(3).map((r) => r.id))
  })

  it("reconciles the principal to the cent, moves no due date, keeps fees and premiums, and reports the interest delta", () => {
    const stored = rows(amortising).map((r) => ({ ...r, creditLifePremiumDue: 1_000, totalDue: r.totalDue + 1_000 }))
    const result = plan(stored)!
    const tail = stored.slice(3)
    const updated = new Map(result.updates.map((u) => [u.id, u]))
    expect(sum(result.updates.map((u) => u.principalDue))).toBe(sum(tail.map((r) => r.principalDue)))
    for (const row of tail) {
      const u = updated.get(row.id)!
      expect(u.principalDue).toBeGreaterThanOrEqual(0)
      expect(u.totalDue).toBe(u.principalDue + u.interestDue + row.feesDue + row.creditLifePremiumDue)
    }
    expect(result.interestDelta).toBe(sum(result.updates.map((u) => u.interestDue)) - sum(tail.map((r) => r.interestDue)))
    expect(result.interestDelta).toBeGreaterThan(0)
  })

  it("gives the annuity of the balance left at the new rate, the same as the engine would for a fresh loan on the tail", () => {
    const stored = rows(amortising, 1_200_000, 0.02, 0)
    const result = plan(stored)!
    const balance = sum(stored.slice(3).map((r) => r.principalDue))
    const fresh = generateSchedule({ principalCents: balance, interestRatePm: 0.025, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate, terms: { ...amortising, instalments: 9 } }).schedule
    expect(result.updates.map((u) => [u.principalDue, u.interestDue])).toEqual(fresh.map((r) => [r.principalDue, r.interestDue]))
  })

  it("leaves paid, part-paid and overdue rows alone: the tail starts after the last row anyone has paid into", () => {
    const stored = rows(amortising)
    const partly = stored.map((r, i) => (i === 7 ? { ...r, totalPaid: 100 } : r))
    expect(plan(partly)!.updates[0]!.id).toBe("r9")
    expect(plan(paid(stored, 6))!.updates[0]!.id).toBe("r7")
    const overdue = stored.map((r, i) => (i === 6 ? { ...r, status: "OVERDUE" } : r))
    expect(plan(overdue)!.updates[0]!.id).toBe("r8")
  })

  it("never rewrites a row already due, however far back the reference took effect", () => {
    const stored = rows(amortising)
    expect(plan(stored, amortising, { effectiveDate: "2027-01-01", today: "2027-06-20" })!.updates[0]!.id).toBe("r6")
  })

  it("has nothing to do when no row is left to reprice", () => {
    expect(plan(paid(rows(amortising), 12))).toBeNull()
    expect(plan(rows(amortising), amortising, { effectiveDate: "2028-06-01" })).toBeNull()
  })

  it("keeps a balloon whole: the last row still pays it, from a lower or a higher rate", () => {
    const terms: RepaymentTerms = { ...amortising, structure: "BALLOON", balloonPct: 0.3 }
    const stored = rows(terms, 10_000_000, 0.02, 0)
    for (const newRatePm of [0.01, 0.03]) {
      const result = plan(stored, terms, { balloonCents: 3_000_000, newRatePm })!
      const last = result.updates.at(-1)!
      expect(last.principalDue).toBeGreaterThan(3_000_000)
      expect(last.principalDue).toBeLessThan(4_000_000)
      expect(sum(result.updates.map((u) => u.principalDue))).toBe(sum(stored.slice(3).map((r) => r.principalDue)))
      const regular = result.updates.slice(0, -1).map((u) => u.totalDue)
      expect(Math.max(...regular) - Math.min(...regular)).toBeLessThanOrEqual(1)
    }
  })

  it("reprices interest-only rows on the outstanding principal, the principal still all on the last", () => {
    const terms: RepaymentTerms = { ...amortising, structure: "INTEREST_ONLY" }
    const stored = rows(terms, 1_200_000, 0.02, 0)
    const result = plan(stored, terms)!
    expect(result.updates.every((u, i, all) => u.principalDue === (i === all.length - 1 ? 1_200_000 : 0))).toBe(true)
    expect(result.updates[0]!.interestDue).toBe(30_000)
  })

  it("keeps the rows of a principal-only grace that are still to come as interest-only rows", () => {
    const terms: RepaymentTerms = { ...amortising, graceKind: "PRINCIPAL_ONLY", graceInstalments: 6 }
    const stored = rows(terms, 1_200_000, 0.02, 0)
    const result = plan(stored, terms)!
    expect(result.updates[0]!.principalDue).toBe(0)
    expect(result.updates[1]!.principalDue).toBe(0)
    expect(result.updates[2]!.principalDue).toBe(0)
    expect(result.updates[3]!.principalDue).toBeGreaterThan(0)
    expect(sum(result.updates.map((u) => u.principalDue))).toBe(1_200_000)
  })

  it("reconciles on weekly and fortnightly loans and on small balances at high rates", () => {
    for (const frequency of ["WEEKLY", "FORTNIGHTLY"] as const) {
      for (const [principal, rate] of [[50_000, 0.3], [1_000_003, 0.0001], [777, 0.05]] as const) {
        const terms: RepaymentTerms = { ...amortising, frequency, instalments: 26 }
        const stored = rows(terms, principal, 0.02, 0)
        const result = plan(stored, terms, { newRatePm: rate, effectiveDate: "2027-01-15" })!
        expect(sum(result.updates.map((u) => u.principalDue))).toBe(sum(stored.filter((r) => result.updates.some((u) => u.id === r.id)).map((r) => r.principalDue)))
        expect(result.updates.every((u) => u.principalDue >= 0 && u.interestDue >= 0)).toBe(true)
      }
    }
  })
})
