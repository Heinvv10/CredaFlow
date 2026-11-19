/** Round 2 pure repros, head 6360672f. RED = bug. */
import { describe, expect, it } from "vitest"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { planInPlace, type PlanRow } from "./plan"

const sumF = (rows: Array<{ totalDue: number; totalPaid: number }>) => rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
type T = { structure: "AMORTISING" | "INTEREST_ONLY" | "BULLET"; graceKind: "NONE" | "FULL" | "PRINCIPAL_ONLY"; graceInstalments: number; frequency: "MONTHLY" | "WEEKLY" | "FORTNIGHTLY" }

function run(cfg: { partPaid: boolean; arrears: boolean; stacked: boolean }) {
  let seed = 7
  const rnd = (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n }
  const moved: Array<Record<string, unknown>> = []
  let tested = 0
  for (let run = 0; run < 4000; run++) {
    const P = 10_000 + rnd(3_000_000)
    const n = 2 + rnd(30)
    const fee = rnd(2) ? 0 : rnd(10_000)
    const model = rnd(2) ? "REDUCING_BALANCE" as const : "FLAT" as const
    const rate = (1 + rnd(9)) / 100
    const asOf = new Date("2026-08-15T10:00:00Z")
    const startDate = new Date(asOf.getTime() - rnd(400) * 86_400_000)
    const structure = (["AMORTISING", "AMORTISING", "INTEREST_ONLY", "BULLET"] as const)[rnd(4)]!
    const grace = structure === "BULLET" || n < 4 ? 0 : rnd(3) === 0 ? 1 + rnd(2) : 0
    const graceKind = grace === 0 ? "NONE" as const : rnd(2) ? "FULL" as const : "PRINCIPAL_ONLY" as const
    if (graceKind === "PRINCIPAL_ONLY" && structure !== "AMORTISING") continue
    const frequency = (["MONTHLY", "MONTHLY", "WEEKLY", "FORTNIGHTLY"] as const)[rnd(4)]!
    const t: T = { structure, graceKind, graceInstalments: grace, frequency }
    let gen
    try { gen = generateSchedule({ principalCents: P, interestRatePm: rate, interestModel: model, monthlyServiceFeeCents: fee, startDate, terms: { ...t, instalments: n } }) } catch { continue }
    let rows: PlanRow[] = gen.schedule.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
    // Paid up to date, or not.
    if (!cfg.arrears) rows = rows.map((r) => (r.dueDate.getTime() <= asOf.getTime() ? { ...r, totalPaid: r.totalDue } : r))
    else rows = rows.map((r, i) => (r.dueDate.getTime() <= asOf.getTime() && i < rnd(rows.length) ? { ...r, totalPaid: r.totalDue } : r))
    if (cfg.partPaid) {
      const i = rows.findIndex((r) => r.totalPaid < r.totalDue)
      if (i >= 0) rows[i] = { ...rows[i]!, totalPaid: 1 + rnd(rows[i]!.totalDue - 1) }
    }
    if (rows.every((r) => r.totalPaid >= r.totalDue)) continue
    const loan = { principal: P, interestRatePm: rate, interestModel: model, monthlyServiceFee: fee, startDate }
    let current = rate
    try {
      if (cfg.stacked) {
        const c = rnd(2) ? { type: "PAYMENT_HOLIDAY" as const, holidayInstalments: 1 + rnd(2) } : { type: "RATE_CHANGE" as const, interestRatePm: (1 + rnd(9)) / 100 }
        const p = planInPlace({ loan, rows, frequency, structure, change: c, asOf })
        rows = p.rows.map((r, i) => ({ ...r, id: `s${i}`, paidAt: null }))
        current = p.interestRatePm
      }
      const before = sumF(rows)
      const p = planInPlace({ loan: { ...loan, interestRatePm: current }, rows, frequency, structure, change: { type: "RATE_CHANGE", interestRatePm: current }, asOf })
      tested++
      const delta = sumF(p.rows.map((r) => r)) - before
      const bad = p.rows.some((r) => r.principalDue < 0 || r.interestDue < 0 || r.feesDue < 0 || r.totalDue !== r.principalDue + r.interestDue + r.feesDue) || p.rows.reduce((s, r) => s + r.principalDue, 0) !== P
      if (delta !== 0 || bad) moved.push({ delta, bad, P, n, model, structure, graceKind, frequency, rate, fee, before })
    } catch (e) { if (!/No principal|holiday/.test(String(e))) moved.push({ error: String(e), structure, frequency, model }) }
  }
  const worst = [...moved].sort((a, b) => Math.abs(Number(b.delta ?? 1e12)) - Math.abs(Number(a.delta ?? 1e12)))
  const by: Record<string, number> = {}
  for (const m of moved) { const k = `${m.structure}/${m.model}/${m.graceKind}`; by[k] = (by[k] ?? 0) + 1 }
  return { tested, moved: moved.length, worst: worst.slice(0, 2), by, up: moved.filter((m) => Number(m.delta) > 0).length, down: moved.filter((m) => Number(m.delta) < 0).length }
}

describe("same-terms moves nothing", () => {
  for (const cfg of [
    { partPaid: false, arrears: false, stacked: false }, { partPaid: true, arrears: false, stacked: false },
    { partPaid: false, arrears: true, stacked: false }, { partPaid: true, arrears: true, stacked: false },
    { partPaid: false, arrears: false, stacked: true }, { partPaid: true, arrears: true, stacked: true },
  ]) {
    it(JSON.stringify(cfg), () => {
      const r = run(cfg)
      process.stderr.write(`\nBRK ${JSON.stringify(cfg)} ${JSON.stringify(r)}\n`)
      expect(r.moved).toBe(0)
    })
  }
})

describe("concrete, 12 rows at 4%, 2 paid, 4 in arrears, 6 to come: same-rate change", () => {
  for (const model of ["FLAT", "REDUCING_BALANCE"] as const) it(model, () => {
    const startDate = new Date("2026-01-01T10:00:00Z")
    const asOf = new Date("2026-07-15T10:00:00Z")
    const P = 1_000_000
    const gen = generateSchedule({ principalCents: P, interestRatePm: 0.04, interestModel: model, monthlyServiceFeeCents: 0, startDate, terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 } })
    const rows: PlanRow[] = gen.schedule.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: i < 2 ? r.totalDue : 0, paidAt: null }))
    const p = planInPlace({ loan: { principal: P, interestRatePm: 0.04, interestModel: model, monthlyServiceFee: 0, startDate }, rows, frequency: "MONTHLY", structure: "AMORTISING", change: { type: "RATE_CHANGE", interestRatePm: 0.04 }, asOf })
    process.stderr.write(`\nBRK concrete ${model} ${JSON.stringify({ before: rows.reduce((s, r) => s + r.interestDue, 0), after: p.totalInterest, carried: p.carriedInterest, freshRows: p.fresh.length })}\n`)
    expect(p.totalInterest).toBe(rows.reduce((s, r) => s + r.interestDue, 0))
  })
})

describe("bullet", () => {
  const startDate = new Date("2026-02-01T10:00:00Z")
  const asOf = new Date("2026-06-15T10:00:00Z") // 4.5 months in
  const P = 1_000_000
  const rows = (): PlanRow[] => generateSchedule({ principalCents: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate, terms: { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0, instalments: 6 } }).schedule.map((r, i) => ({ id: `r${i}`, installmentNo: 1, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
  const loan = { principal: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE" as const, monthlyServiceFee: 0, startDate }
  it("shortening keeps interest earned to the new due date", () => {
    const p = planInPlace({ loan, rows: rows(), frequency: "MONTHLY", structure: "BULLET", change: { type: "TERM_CHANGE", instalments: 2 }, asOf })
    const months = (p.maturityDate.getTime() - startDate.getTime()) / (30.4 * 86_400_000)
    process.stderr.write(`\nBRK bullet shorten ${JSON.stringify({ due: p.maturityDate, interest: p.totalInterest, months })}\n`)
    expect(p.totalInterest).toBeGreaterThanOrEqual(Math.round(40_000 * Math.floor(months)))
  })
  it("a rate cut 4.5 months into 6 does not reprice the elapsed time", () => {
    const p = planInPlace({ loan, rows: rows(), frequency: "MONTHLY", structure: "BULLET", change: { type: "RATE_CHANGE", interestRatePm: 0.02 }, asOf })
    process.stderr.write(`\nBRK bullet rate ${p.totalInterest}\n`)
    expect(p.totalInterest).toBeGreaterThanOrEqual(40_000 * 4 + 20_000 * 2 - 1)
  })
})
