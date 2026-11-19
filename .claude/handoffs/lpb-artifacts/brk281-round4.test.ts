/** Round 4 pure repros, head 4bfe04d5. RED = bug. */
import { describe, expect, it } from "vitest"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { planInPlace, type PlanRow } from "./plan"

const asOf = new Date("2026-08-15T10:00:00Z")
const DAY = 86_400_000
const rng = (s0: number) => { let seed = s0; return (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n } }
const openSum = (rows: Array<{ totalDue: number; totalPaid: number; carriedPrincipalDue?: number }>, k: "carriedPrincipalDue") => rows.filter((r) => r.totalPaid < r.totalDue).reduce((s, r) => s + (r[k] ?? 0), 0)
const owed = (rows: Array<{ totalDue: number; totalPaid: number }>) => rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)

describe("carriedPrincipalDue survives every stack", () => {
  it("fuzz", () => {
    const rnd = rng(4)
    const bad: Record<string, unknown>[] = []
    const seen: Record<string, number> = {}
    for (let i = 0; i < 15000; i++) {
      const P = 10_000 + rnd(3_000_000); const n = 2 + rnd(24); const fee = rnd(2) ? 0 : rnd(5000)
      const model = rnd(2) ? "REDUCING_BALANCE" as const : "FLAT" as const
      const rate = (1 + rnd(9)) / 100
      const startDate = new Date(asOf.getTime() - rnd(500) * DAY)
      const structure = (["AMORTISING", "AMORTISING", "INTEREST_ONLY", "BULLET"] as const)[rnd(4)]!
      const frequency = (["MONTHLY", "MONTHLY", "WEEKLY", "FORTNIGHTLY"] as const)[rnd(4)]!
      const gen = generateSchedule({ principalCents: P, interestRatePm: rate, interestModel: model, monthlyServiceFeeCents: fee, startDate, terms: { frequency, structure, graceKind: "NONE", graceInstalments: 0, instalments: n } })
      let rows: PlanRow[] = gen.schedule.map((r, j) => ({ id: `r${j}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
      const dueCount = rows.filter((r) => r.dueDate <= asOf).length
      const paid = rnd(dueCount + 1)
      rows = rows.map((r, j) => (j < paid ? { ...r, totalPaid: r.totalDue } : r))
      if (rows.every((r) => r.totalPaid >= r.totalDue)) continue
      const loan = { principal: P, interestRatePm: rate, interestModel: model, monthlyServiceFee: fee, startDate }
      const base = { frequency, structure, asOf }
      const tail0 = rows.find((r) => r.dueDate > asOf && r.totalPaid < r.totalDue)
      const firstDueDate = new Date((tail0 ? tail0.dueDate.getTime() : asOf.getTime() + 70 * DAY) + 2 * 3600e3).toISOString().slice(0, 10)
      let p
      try { p = planInPlace({ ...base, loan, rows, change: { type: "RESCHEDULE", firstDueDate } }) } catch { continue }
      let cur = p.rows.map((r, j) => ({ ...r, id: `a${j}`, paidAt: null })) as PlanRow[]
      const moved = openSum(cur as never, "carriedPrincipalDue")
      if (moved === 0) continue
      let rateNow = rate
      for (let step = 0; step < 3; step++) {
        const c = [{ type: "TERM_CHANGE", instalments: 1 + rnd(36) }, { type: "RATE_CHANGE", interestRatePm: rnd(rateNow * 100 + 1) / 100 }, { type: "PAYMENT_HOLIDAY", holidayInstalments: 1 + rnd(3) }, { type: "RESCHEDULE", firstDueDate: new Date(cur.find((r) => r.totalPaid < r.totalDue)!.dueDate.getTime() + 40 * DAY).toISOString().slice(0, 10) }][rnd(4)] as Parameters<typeof planInPlace>[0]["change"]
        const before = openSum(cur as never, "carriedPrincipalDue")
        const bearingZero = cur.filter((r) => r.totalPaid < r.totalDue).reduce((s, r) => s + r.principalDue, 0) === before
        let q
        try { q = planInPlace({ ...base, loan: { ...loan, interestRatePm: rateNow }, rows: cur, change: c }) } catch { break }
        const after = openSum(q.rows as never, "carriedPrincipalDue")
        const key = `${c.type}${bearingZero ? "/bearing0" : ""}`
        if (after !== before) { seen[key] = (seen[key] ?? 0) + 1; if (bad.length < 4) bad.push({ key, before, after, structure, model, step }) }
        if (q.rows.some((r) => r.principalDue < 0 || r.interestDue < 0 || r.feesDue < 0 || r.totalDue !== r.principalDue + r.interestDue + r.feesDue) || q.rows.reduce((s, r) => s + r.principalDue, 0) !== P) { seen.badrow = (seen.badrow ?? 0) + 1 }
        cur = q.rows.map((r, j) => ({ ...r, id: `b${step}${j}`, paidAt: null })) as PlanRow[]
        rateNow = q.interestRatePm
        void moved
      }
    }
    process.stderr.write(`\nBRK carried ${JSON.stringify(seen)} ${JSON.stringify(bad)}\n`)
    expect(seen).toEqual({})
  })

  it("bearing 0, then a holiday: moved principal bears no interest", () => {
    const P = 1_000_000
    const startDate = new Date("2026-01-01T10:00:00Z")
    const gen = generateSchedule({ principalCents: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate, terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 6 } })
    const asOfLate = new Date("2026-08-15T10:00:00Z")
    const rows: PlanRow[] = gen.schedule.map((r, j) => ({ id: `r${j}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
    const base = { frequency: "MONTHLY" as const, structure: "AMORTISING" as const, asOf: asOfLate, loan: { principal: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE" as const, monthlyServiceFee: 0, startDate } }
    const r = planInPlace({ ...base, rows, change: { type: "RESCHEDULE", firstDueDate: "2026-09-01" } })
    const owedR = owed(r.rows)
    const t = planInPlace({ ...base, rows: r.rows.map((x, j) => ({ ...x, id: `a${j}`, paidAt: null })), change: { type: "TERM_CHANGE", instalments: 6 } })
    const h = planInPlace({ ...base, rows: t.rows.map((x, j) => ({ ...x, id: `b${j}`, paidAt: null })), change: { type: "PAYMENT_HOLIDAY", holidayInstalments: 3 } })
    process.stderr.write(`\nBRK bearing0 ${JSON.stringify({ owedR, afterTerm: owed(t.rows), afterHoliday: owed(h.rows), deferred: h.deferredInterest })}\n`)
    expect(h.deferredInterest).toBe(0)
  })
})

describe("cure clock", () => {
  it("rescheduling monthly with no payment keeps Stage 3 (defaulted flag true)", () => {
    const loanAt = (over: Record<string, unknown>) => ({ id: "l", reference: "r", productId: "p", contractType: "LOAN", status: "ACTIVE", collectionsStage: "NONE", startDate: new Date("2026-01-01"), principal: 1_000_000, outstandingPrincipal: 1_000_000, chargesOutstanding: 0, debtReview: false, flags: [], ...over }) as never
    for (const flag of [true, false]) {
      let prior: never = { stage: 3, stageSince: "2026-01-31", cureStartedOn: null, restructured: false, runDate: "2026-01-31" } as never
      const stages: number[] = []
      for (let m = 2; m <= 28; m++) {
        const y = 2026 + Math.floor((m - 1) / 12); const mm = String(((m - 1) % 12) + 1).padStart(2, "0"); const runDate = `${y}-${mm}-28`
        const a = assessLoan(loanAt({ restructuredOn: `${y}-${mm}-20`, defaultedAtRestructure: flag, schedule: [{ dueDate: new Date(`${y + 2}-01-01`), principalDue: 1_000_000, interestDue: 0, feesDue: 0, totalDue: 1_000_000, totalPaid: 0 }] }), { runAt: new Date(`${runDate}T21:00:00Z`), settings: DEFAULT_SETTINGS } as never, prior)
        stages.push(a.staging.stage)
        prior = { stage: a.staging.stage, stageSince: a.staging.stageSince, cureStartedOn: a.staging.cureStartedOn, restructured: a.staging.restructured, runDate } as never
      }
      process.stderr.write(`\nBRK serial flag=${flag} ${stages.join("")}\n`)
      expect(Math.min(...stages)).toBe(3)
    }
  })
})
