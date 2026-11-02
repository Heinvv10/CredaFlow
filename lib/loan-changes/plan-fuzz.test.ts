/** Same terms move nothing, to the cent: whatever the structure, arrears, part-payments and earlier changes. A breaker's fuzz, kept. */
import { describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { planInPlace, type PlanRow } from "./plan"

const sumF = (rows: Array<{ totalDue: number; totalPaid: number }>) => rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
type T = { structure: "AMORTISING" | "INTEREST_ONLY" | "BULLET"; graceKind: "NONE" | "FULL" | "PRINCIPAL_ONLY"; graceInstalments: number; frequency: "MONTHLY" | "WEEKLY" | "FORTNIGHTLY" }

function maker(start: number) {
  let seed = start
  return (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n }
}

function run(cfg: { partPaid: boolean; arrears: boolean; stacked: boolean; reschedule?: boolean }) {
  const rnd = maker(7)
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
      // Rescheduling to the next instalment's own date moves the arrears, and not one cent of what is owed.
      const next = rows.find((r) => r.totalPaid < r.totalDue && sastCalendarDate(r.dueDate) > sastCalendarDate(asOf))
      const same = cfg.reschedule && next
        ? { type: "RESCHEDULE" as const, firstDueDate: sastCalendarDate(next.dueDate) }
        : { type: "RATE_CHANGE" as const, interestRatePm: current }
      if (cfg.reschedule && !next) continue
      const p = planInPlace({ loan: { ...loan, interestRatePm: current }, rows, frequency, structure, change: same, asOf })
      tested++
      const delta = sumF(p.rows.map((r) => r)) - before
      const bad = p.rows.some((r) => r.principalDue < 0 || r.interestDue < 0 || r.feesDue < 0 || r.totalDue !== r.principalDue + r.interestDue + r.feesDue) || p.rows.reduce((s, r) => s + r.principalDue, 0) !== P
      if (delta !== 0 || bad) moved.push({ delta, bad, P, n, model, structure, graceKind, frequency, rate, fee, before })
    } catch (e) { if (!/No principal|holiday|reschedule the arrears/.test(String(e))) moved.push({ error: String(e), structure, frequency, model }) }
  }
  const worst = [...moved].sort((a, b) => Math.abs(Number(b.delta ?? 1e12)) - Math.abs(Number(a.delta ?? 1e12)))
  const by: Record<string, number> = {}
  for (const m of moved) { const k = `${m.structure}/${m.model}/${m.graceKind}`; by[k] = (by[k] ?? 0) + 1 }
  return { tested, moved: moved.length, worst: worst.slice(0, 2), by, up: moved.filter((m) => Number(m.delta) > 0).length, down: moved.filter((m) => Number(m.delta) < 0).length }
}

/** After a reschedule, what it carried stands whatever a later change does, and the same terms still move nothing. */
function afterReschedule() {
  const rnd = maker(281)
  const asOf = new Date("2026-08-15T10:00:00Z")
  const lost: unknown[] = []
  let tested = 0
  for (let run = 0; run < 4000; run++) {
    const P = 10_000 + rnd(3_000_000)
    const n = 2 + rnd(30)
    const fee = rnd(2) ? 0 : rnd(10_000)
    const interestModel = rnd(2) ? "REDUCING_BALANCE" as const : "FLAT" as const
    const rate = (1 + rnd(9)) / 100
    const startDate = new Date(asOf.getTime() - rnd(400) * 86_400_000)
    const structure = (["AMORTISING", "AMORTISING", "INTEREST_ONLY", "BULLET"] as const)[rnd(4)]!
    const frequency = (["MONTHLY", "MONTHLY", "WEEKLY", "FORTNIGHTLY"] as const)[rnd(4)]!
    const rows: PlanRow[] = generateSchedule({ principalCents: P, interestRatePm: rate, interestModel, monthlyServiceFeeCents: fee, startDate, terms: { frequency, structure, graceKind: "NONE", graceInstalments: 0, instalments: n } })
      .schedule.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
    const dueCount = rows.filter((r) => r.dueDate <= asOf).length
    const paid = rows.map((r, i) => (i < rnd(dueCount + 1) ? { ...r, totalPaid: r.totalDue } : r))
    const base = { loan: { principal: P, interestRatePm: rate, interestModel, monthlyServiceFee: fee, startDate }, frequency, structure, asOf }
    const ahead = paid.find((r) => r.dueDate > asOf && r.totalPaid < r.totalDue)
    if (paid.every((r) => r.totalPaid >= r.totalDue)) continue
    const moved = planInPlace({ ...base, rows: paid, change: { type: "RESCHEDULE", firstDueDate: new Date((ahead ? ahead.dueDate : new Date(asOf.getTime() + 62 * 86_400_000)).getTime() + (5 + rnd(30)) * 86_400_000).toISOString().slice(0, 10) } })
    const written = moved.rows.map((r, i) => ({ ...r, id: `y${i}`, paidAt: null }))
    const carried = moved.fresh.reduce((s, r) => s + r.carriedInterestDue, 0)
    for (const change of [{ type: "RATE_CHANGE", interestRatePm: 0 }, { type: "TERM_CHANGE", instalments: 1 }, { type: "RATE_CHANGE", interestRatePm: rate }] as const) {
      let after
      try {
        after = planInPlace({ ...base, rows: written, change })
      } catch (error) {
        if (/No principal/.test(String(error))) continue
        throw error
      }
      tested++
      if (after.fresh.reduce((s, r) => s + r.interestDue, 0) < carried) lost.push({ why: "earned lost", change, carried, structure, interestModel })
      if (change.type === "RATE_CHANGE" && change.interestRatePm === rate && after.totalRepayable !== moved.totalRepayable) lost.push({ why: "same terms moved", structure, interestModel, frequency })
      if (after.rows.reduce((s, r) => s + r.principalDue, 0) !== P) lost.push({ why: "principal", structure, interestModel })
      if (after.rows.some((r) => r.interestDue < 0 || r.feesDue < 0 || r.principalDue < 0)) lost.push({ why: "negative", structure, interestModel })
    }
  }
  return { tested, lost }
}

/** Arrears principal a reschedule moved stays marked through any stack of later changes, and the rows always add up. */
function stackedMarks() {
  const rnd = maker(4)
  const asOf = new Date("2026-08-15T10:00:00Z")
  const lost: unknown[] = []
  let tested = 0
  const openMarks = (rows: readonly PlanRow[]) => rows.filter((r) => r.totalPaid < r.totalDue).reduce((s, r) => s + (r.carriedPrincipalDue ?? 0), 0)
  for (let run = 0; run < 4000; run++) {
    const P = 10_000 + rnd(3_000_000)
    const n = 2 + rnd(24)
    const fee = rnd(2) ? 0 : rnd(5_000)
    const interestModel = rnd(2) ? "REDUCING_BALANCE" as const : "FLAT" as const
    const rate = (1 + rnd(9)) / 100
    const startDate = new Date(asOf.getTime() - rnd(500) * 86_400_000)
    const structure = (["AMORTISING", "AMORTISING", "INTEREST_ONLY", "BULLET"] as const)[rnd(4)]!
    const frequency = (["MONTHLY", "MONTHLY", "WEEKLY", "FORTNIGHTLY"] as const)[rnd(4)]!
    const generated = generateSchedule({ principalCents: P, interestRatePm: rate, interestModel, monthlyServiceFeeCents: fee, startDate, terms: { frequency, structure, graceKind: "NONE", graceInstalments: 0, instalments: n } }).schedule
    const dueCount = generated.filter((r) => r.dueDate <= asOf).length
    const paidCount = rnd(dueCount + 1)
    const rows: PlanRow[] = generated.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: i < paidCount ? r.totalDue : 0, paidAt: null }))
    if (rows.every((r) => r.totalPaid >= r.totalDue)) continue
    const base = { loan: { principal: P, interestRatePm: rate, interestModel, monthlyServiceFee: fee, startDate }, frequency, structure, asOf }
    const ahead = rows.find((r) => r.dueDate > asOf && r.totalPaid < r.totalDue)
    const first = new Date((ahead ? ahead.dueDate.getTime() : asOf.getTime() + 70 * 86_400_000) + 2 * 3_600_000).toISOString().slice(0, 10)
    let current = planInPlace({ ...base, rows, change: { type: "RESCHEDULE", firstDueDate: first } }).rows.map((r, i): PlanRow => ({ ...r, id: `a${i}`, paidAt: null }))
    let rateNow = rate
    for (let step = 0; step < 3 && openMarks(current) > 0; step++) {
      const change = [{ type: "TERM_CHANGE" as const, instalments: 1 + rnd(36) }, { type: "RATE_CHANGE" as const, interestRatePm: rnd(10) / 100 }, { type: "PAYMENT_HOLIDAY" as const, holidayInstalments: 1 + rnd(3) }][rnd(3)]!
      const before = openMarks(current)
      let next
      try {
        next = planInPlace({ ...base, loan: { ...base.loan, interestRatePm: rateNow }, rows: current, change })
      } catch (error) {
        if (/reschedule|No principal/.test(String(error))) break
        throw error
      }
      tested++
      if (openMarks(next.rows.map((r, i) => ({ ...r, id: `x${i}`, paidAt: null }))) !== before) lost.push({ why: "marks", change, structure, interestModel, frequency })
      if (next.rows.reduce((s, r) => s + r.principalDue, 0) !== P) lost.push({ why: "principal", change, structure })
      if (next.rows.some((r) => r.principalDue < 0 || r.interestDue < 0 || r.feesDue < 0 || r.totalDue !== r.principalDue + r.interestDue + r.feesDue)) lost.push({ why: "row", change, structure })
      current = next.rows.map((r, i): PlanRow => ({ ...r, id: `b${step}${i}`, paidAt: null }))
      rateNow = next.interestRatePm
    }
  }
  return { tested, lost }
}

describe("through a stack of changes", () => {
  it("moved principal stays marked and bears no interest", () => {
    const { tested, lost } = stackedMarks()
    expect(tested).toBeGreaterThan(1_000)
    expect(lost.slice(0, 3)).toEqual([])
  })
})

describe("after a reschedule", () => {
  it("carried interest stands, same terms move nothing, the rows add up", () => {
    const { tested, lost } = afterReschedule()
    expect(tested).toBeGreaterThan(1_000)
    expect(lost.slice(0, 3)).toEqual([])
  })
})

describe("same-terms moves nothing", () => {
  for (const cfg of [
    { partPaid: false, arrears: false, stacked: false }, { partPaid: true, arrears: false, stacked: false },
    { partPaid: false, arrears: true, stacked: false }, { partPaid: true, arrears: true, stacked: false },
    { partPaid: false, arrears: false, stacked: true }, { partPaid: true, arrears: true, stacked: true },
    { partPaid: false, arrears: true, stacked: false, reschedule: true }, { partPaid: true, arrears: true, stacked: true, reschedule: true },
  ]) {
    it(JSON.stringify(cfg), () => {
      const r = run(cfg)
      expect(r.tested).toBeGreaterThan(1_000)
      expect(r.worst).toEqual([])
      expect(r.moved).toBe(0)
    })
  }
})
