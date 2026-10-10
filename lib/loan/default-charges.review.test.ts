import { describe, expect, it } from "vitest"
import { computeDefaultCharges, type DefaultChargeInput } from "@/lib/loan/default-charges"
import { d, input, row } from "./default-charges.test-helpers"

// Regressions for the engine.

describe("computeDefaultCharges — review round 1", () => {
  // R100 principal, 5% pm, bullet due 1 Jan 2026, R5 interest, no fee.
  const small = row("2026-01-01", 10_000, 500)
  const base = (over: Partial<DefaultChargeInput> = {}): DefaultChargeInput => input({
    schedule: [small], maturityDate: small.dueDate, asOf: d("2027-12-01"), ...over,
  })
  const total = (r: ReturnType<typeof computeDefaultCharges>) => r.interestAccrued + r.feesAccrued

  it("keeps a letter inside the in duplum cap when it is charged on day 2 of the default", () => {
    const r = computeDefaultCharges(base({ adminCharges: [{ id: "s129", date: d("2026-01-03"), amount: 8_200 }] }))
    expect(total(r)).toBeLessThanOrEqual(10_000)
  })

  it("does not charge a letter dated before any default was open (the first day of default)", () => {
    const r = computeDefaultCharges(base({ adminCharges: [{ id: "s129", date: d("2026-01-02"), amount: 8_200 }] }))
    expect(r.postings.filter((p) => p.type === "DEFAULT_ADMIN")).toEqual([])
    expect(total(r)).toBeLessThanOrEqual(10_000)
  })

  it("does not charge a letter dated after the loan was paid in full on time", () => {
    const r = computeDefaultCharges(base({
      asOf: d("2026-02-01"),
      receipts: [{ id: "paid", amount: 10_500, receivedAt: d("2026-01-01") }],
      adminCharges: [{ id: "s129", date: d("2026-01-15"), amount: 8_200 }],
    }))
    expect(r.feesAccrued).toBe(0)
  })

  it("does not charge the month's service fee to a client who settles in full on that 1st", () => {
    const r = computeDefaultCharges(base({
      monthlyServiceFee: 6_900, asOf: d("2026-02-10"),
      receipts: [{ id: "settle", amount: 50_000, receivedAt: d("2026-02-01") }],
    }))
    expect(r.postings.filter((p) => p.type === "SERVICE_FEE")).toEqual([])
  })

  it("reserves the contractual interest and fees of instalments not yet due inside the in duplum cap", () => {
    // 6 x R199 (R100 principal + R99), #1 missed, two letters: cap R600, of
    // which R495 is already committed to instalments 2..6.
    const rows = [1, 2, 3, 4, 5, 6].map((m) => row(`2026-0${m}-01`, 10_000, 9_900))
    const r = computeDefaultCharges(input({
      schedule: rows, maturityDate: rows[5].dueDate, asOf: d("2027-06-01"),
      adminCharges: [
        { id: "s129-1", date: d("2026-01-10"), amount: 8_200 },
        { id: "s129-2", date: d("2026-02-10"), amount: 8_200 },
      ],
    }))
    expect(total(r) + 5 * 9_900).toBeLessThanOrEqual(60_000)
    expect(r.inDuplum).toEqual({ capBase: 60_000, accrued: total(r) + 5 * 9_900, reached: true })
  })

  it("reports in duplum accrued as the unclamped total, not the cap less what is left", () => {
    expect(computeDefaultCharges(input({})).inDuplum).toEqual({ capBase: 200_000, accrued: 3_000, reached: false })
    // Contractual interest still to fall due (R200) already exceeds the
    // unpaid principal (R110): no charge fits, and the report says by how much.
    const rows = [row("2026-01-01", 10_000, 500), row("2026-02-01", 1_000, 20_000)]
    const r = computeDefaultCharges(input({ schedule: rows, maturityDate: rows[1].dueDate, asOf: d("2026-01-20") }))
    expect(r.interestAccrued).toBe(0)
    expect(r.inDuplum).toEqual({ capBase: 11_000, accrued: 20_000, reached: true })
  })

  it("accrues and posts nothing on or after accrueUntil, but still allocates later receipts", () => {
    const r = computeDefaultCharges(input({
      monthlyServiceFee: 6_900, asOf: d("2026-11-15"), accrueUntil: d("2026-09-06"),
      receipts: [{ id: "p1", amount: 10_000, receivedAt: d("2026-10-10") }],
    }))
    // Sep 2..5 only: 4 x 333.33.
    expect(r.interestAccrued).toBe(1_333)
    expect(r.feesAccrued).toBe(0)
    expect(r.receiptSplits).toEqual([{ receiptId: "p1", toDefaultInterest: 1_333, toFees: 0, toSchedule: 8_667 }])
  })
})

describe("review round 2", () => {
  it("R2-G: a service fee falling on the 1st after a month-end maturity stays inside the in duplum cap", () => {
    const r = computeDefaultCharges({
      schedule: [{ dueDate: d("2026-01-31"), principalDue: 10_000, interestDue: 500, feesDue: 0, totalDue: 10_500 }],
      receipts: [], adminCharges: [], interestRatePm: 0.05, monthlyServiceFee: 6_900,
      maturityDate: d("2026-01-31"), asOf: d("2027-12-01"),
    })
    expect(r.interestAccrued + r.feesAccrued).toBeLessThanOrEqual(10_000)
    expect(r.postings.filter((p) => p.type === "SERVICE_FEE").map((p) => p.day)[0]).not.toBe("2026-02-01")
  })
})

describe("same-day receipts and letters", () => {
  const at = (iso: string) => new Date(iso)
  const settles = { id: "p1", amount: 216_900 + 8_333, receivedAt: at("2026-09-26T10:00:00+02:00") }
  it("does not charge a letter confirmed after the receipt that settled the loan that day", () => {
    const r = computeDefaultCharges(input({
      asOf: at("2026-09-27T12:00:00+02:00"), receipts: [settles],
      adminCharges: [{ id: "s129", date: at("2026-09-26T11:00:00+02:00"), amount: 8_200 }],
    }))
    expect(r.postings.filter((p) => p.type === "DEFAULT_ADMIN")).toEqual([])
  })

  it("charges a letter confirmed before that day's receipt, while the default was still open", () => {
    const r = computeDefaultCharges(input({
      asOf: at("2026-09-27T12:00:00+02:00"), receipts: [settles],
      adminCharges: [{ id: "s129", date: at("2026-09-26T09:00:00+02:00"), amount: 8_200 }],
    }))
    expect(r.postings.filter((p) => p.type === "DEFAULT_ADMIN").map((p) => p.amount)).toEqual([8_200])
  })
})

describe("review round 3", () => {
  it("R3-4: a receipt and a letter at the same instant: the receipt comes first", () => {
    const at = new Date("2026-09-26T10:00:00+02:00")
    const r = computeDefaultCharges(input({
      asOf: d("2026-09-27"),
      receipts: [{ id: "p1", amount: 216_900 + 8_000, receivedAt: at }],
      adminCharges: [{ id: "s129", date: at, amount: 8_200 }],
    }))
    expect(r.postings.filter((p) => p.type === "DEFAULT_ADMIN")).toEqual([])
  })

  it("R3-S: over 3,000 random loans, receipts and letters, never breaches the cap and never loses a receipt", () => {
    const DAY = 86_400_000
    const bad: unknown[] = []
    for (let seed = 1; seed < 3000; seed++) {
      let x = seed
      const rnd = () => ((x = (x * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
      const start = d("2026-01-31").getTime()
      const rows = Array.from({ length: 1 + Math.floor(rnd() * 3) }, (_, i) => {
        const principalDue = 5_000 + Math.floor(rnd() * 50_000)
        return { dueDate: new Date(start + i * 30 * DAY), principalDue, interestDue: 500, feesDue: 690, totalDue: principalDue + 1_190 }
      })
      const receipts = Array.from({ length: Math.floor(rnd() * 4) }, (_, i) => ({ id: `r${i}`, amount: 1_000 + Math.floor(rnd() * 20_000), receivedAt: new Date(start + Math.floor(rnd() * 300) * DAY) }))
      const adminCharges = Array.from({ length: Math.floor(rnd() * 3) }, (_, i) => ({ id: `l${i}`, amount: 8_200, date: new Date(start + Math.floor(rnd() * 300) * DAY) }))
      const base = { schedule: rows, receipts, adminCharges, interestRatePm: 0.05, monthlyServiceFee: 6_900, maturityDate: rows.at(-1)!.dueDate, asOf: new Date(start + 400 * DAY) }
      const r = computeDefaultCharges(base)
      const cash = receipts.reduce((s, receipt) => s + receipt.amount, 0)
      const accounted = r.scheduleAllocated + r.interestPaid + r.feesPaid + r.unallocated
      if (accounted !== cash || (r.inDuplum && r.inDuplum.accrued > r.inDuplum.capBase + 1)) {
        bad.push({ seed, accounted, cash, inDuplum: r.inDuplum })
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  }, 60_000)
})
