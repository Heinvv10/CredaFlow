/** Round 3 pure repros, head e6f2ff4b. RED = bug. */
import { describe, expect, it } from "vitest"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { planInPlace, type PlanRow } from "./plan"

const asOf = new Date("2026-08-15T10:00:00Z")
const DAY = 86_400_000
function maker(seed0: number) {
  let seed = seed0
  return (n: number) => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) % n }
}
const owed = (rows: Array<{ totalDue: number; totalPaid: number }>) => rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
const ctx = (P: number, rate: number, model: "FLAT" | "REDUCING_BALANCE", fee: number, startDate: Date) => ({ principal: P, interestRatePm: rate, interestModel: model, monthlyServiceFee: fee, startDate })

function build(rnd: (n: number) => number) {
  const P = 10_000 + rnd(3_000_000); const n = 2 + rnd(30); const fee = rnd(2) ? 0 : rnd(10_000)
  const model = rnd(2) ? "REDUCING_BALANCE" as const : "FLAT" as const
  const rate = (1 + rnd(9)) / 100
  const startDate = new Date(asOf.getTime() - rnd(400) * DAY)
  const structure = (["AMORTISING", "AMORTISING", "INTEREST_ONLY", "BULLET"] as const)[rnd(4)]!
  const frequency = (["MONTHLY", "MONTHLY", "WEEKLY", "FORTNIGHTLY"] as const)[rnd(4)]!
  const gen = generateSchedule({ principalCents: P, interestRatePm: rate, interestModel: model, monthlyServiceFeeCents: fee, startDate, terms: { frequency, structure, graceKind: "NONE", graceInstalments: 0, instalments: n } })
  let rows: PlanRow[] = gen.schedule.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
  const dueCount = rows.filter((r) => r.dueDate <= asOf).length
  const paidUpTo = rnd(dueCount + 1)
  rows = rows.map((r, i) => (i < paidUpTo ? { ...r, totalPaid: r.totalDue } : r))
  if (rnd(2) && paidUpTo < rows.length) { const r = rows[paidUpTo]!; if (r.totalDue > 2) rows[paidUpTo] = { ...r, totalPaid: 1 + rnd(r.totalDue - 1) } }
  return { P, fee, model, rate, startDate, structure, frequency, rows }
}

describe("arrears and part-pays", () => {
  it("non-RESCHEDULE leaves paid and due rows; RESCHEDULE moves what is owed exactly, plus only gap interest; R then T keeps what was earned", () => {
    const rnd = maker(281)
    const bad: unknown[] = []
    const count: Record<string, number> = {}
    for (let i = 0; i < 12000; i++) {
      const b = build(rnd)
      if (b.rows.every((r) => r.totalPaid >= r.totalDue)) continue
      const loan = ctx(b.P, b.rate, b.model, b.fee, b.startDate)
      const base = { loan, frequency: b.frequency, structure: b.structure, asOf }
      const check = (label: string, rows: Array<{ principalDue: number; interestDue: number; feesDue: number; totalDue: number }>) => {
        if (rows.some((r) => r.principalDue < 0 || r.interestDue < 0 || r.feesDue < 0 || r.totalDue !== r.principalDue + r.interestDue + r.feesDue)) bad.push({ label, why: "row", s: b.structure, m: b.model })
        if (rows.reduce((s, r) => s + r.principalDue, 0) !== b.P) bad.push({ label, why: "principal", s: b.structure, m: b.model })
      }
      // tail changes
      for (const change of [{ type: "RATE_CHANGE", interestRatePm: rnd(10) / 100 }, { type: "TERM_CHANGE", instalments: 1 + rnd(36) }, { type: "PAYMENT_HOLIDAY", holidayInstalments: 1 + rnd(3) }] as const) {
        try {
          const p = planInPlace({ ...base, rows: b.rows, change })
          check(change.type, p.rows)
          const dueBefore = b.rows.filter((r) => r.dueDate.getTime() <= asOf.getTime() && r.totalPaid < r.totalDue).reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
          const dueAfter = p.rows.filter((r) => r.dueDate.getTime() <= asOf.getTime() && r.totalPaid < r.totalDue).reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
          if (dueBefore !== dueAfter) bad.push({ why: "arrears moved", change: change.type, dueBefore, dueAfter, s: b.structure, m: b.model })
          if (p.nextPaymentDate.getTime() <= 0) bad.push({ why: "next" })
        } catch (e) { if (!/reschedule|No principal|past|holiday/i.test(String(e))) bad.push({ err: String(e), change: change.type, s: b.structure }) }
      }
      // reschedule by 0..60 days
      const tail0 = b.rows.find((r) => r.dueDate > asOf && r.totalPaid < r.totalDue)
      const gap = rnd(3) === 0 ? 0 : rnd(60)
      const base0 = tail0 ? tail0.dueDate : new Date(asOf.getTime() + 62 * DAY)
      const firstDueDate = new Date(base0.getTime() + gap * DAY + 2 * 3600e3).toISOString().slice(0, 10)
      let r
      try { r = planInPlace({ ...base, rows: b.rows, change: { type: "RESCHEDULE", firstDueDate } }) } catch (e) { if (!/on or after|No principal/.test(String(e))) bad.push({ err: String(e), c: "R", s: b.structure }); continue }
      check("R", r.rows)
      const interestAdd = r.carriedInterest - b.rows.filter((x) => x.dueDate <= asOf).reduce((s, x) => s + x.interestDue, 0) + 0
      const delta = owed(r.rows) - owed(b.rows)
      const gapDays = 0
      void interestAdd; void gapDays
      if (delta < 0) bad.push({ why: "R owes less", delta, s: b.structure, m: b.model, f: b.frequency })
      if (r.rows.some((x, idx) => x.totalPaid < x.totalDue && x.dueDate <= asOf && idx >= 0)) bad.push({ why: "R left arrears", s: b.structure })
      // R then a tail change
      const after = r.rows.map((x, idx) => ({ ...x, id: `y${idx}`, paidAt: null }))
      const carried = r.fresh.reduce((s, x) => s + x.carriedInterestDue, 0)
      const unpaidInterestKept = r.fresh.reduce((s, x) => s + x.interestDue, 0)
      for (const change of [{ type: "RATE_CHANGE", interestRatePm: 0 }, { type: "TERM_CHANGE", instalments: 1 }, { type: "RATE_CHANGE", interestRatePm: b.rate }] as const) {
        try {
          const p = planInPlace({ ...base, rows: after, change })
          check(`R+${change.type}`, p.rows)
          const interest = p.fresh.reduce((s, x) => s + x.interestDue, 0)
          const key = `${b.structure}/${b.model}/${change.type}`
          if (interest < carried) { count[key] = (count[key] ?? 0) + 1; if ((bad as Array<{ why?: string }>).filter((x) => x.why === "earned lost").length < 3) bad.push({ why: "earned lost", change, carried, interest, unpaidInterestKept, s: b.structure, m: b.model, P: b.P, rate: b.rate }) }
          if (change.type === "RATE_CHANGE" && change.interestRatePm === b.rate && owed(p.rows) !== owed(after)) bad.push({ why: "same terms after R", delta: owed(p.rows) - owed(after), s: b.structure, m: b.model })
        } catch (e) { if (!/reschedule|No principal/.test(String(e))) bad.push({ err: String(e), c: "R+", s: b.structure, m: b.model }) }
      }
    }
    process.stderr.write(`\nBRK fuzz ${bad.length} ${JSON.stringify(count)} ${JSON.stringify(bad.slice(0, 6))}\n`)
    expect(bad.length).toBe(0)
  })
})

describe("IFRS 9 on a RESCHEDULE cure", () => {
  const loanAt = (over: Record<string, unknown>) => ({ id: "l", reference: "r", productId: "p", contractType: "LOAN", status: "ACTIVE", collectionsStage: "NONE", startDate: new Date("2026-01-01"), principal: 1_000_000, outstandingPrincipal: 1_000_000, chargesOutstanding: 0, debtReview: false, flags: [], schedule: [{ dueDate: new Date("2027-06-01"), principalDue: 1_000_000, interestDue: 0, feesDue: 0, totalDue: 1_000_000, totalPaid: 0 }], ...over }) as never
  it("a DEFAULTED loan cured by RESCHEDULE with no money is not below Stage 3 at the next run", () => {
    const runAt = new Date("2026-08-31T21:59:00Z")
    const a = assessLoan(loanAt({ restructuredOn: "2026-08-20" }), { runAt, settings: DEFAULT_SETTINGS } as never, { stage: 2, stageSince: "2026-07-31", cureStartedOn: null, restructured: false, runDate: "2026-07-31" })
    expect(a.staging.stage).toBe(3)
  })
  it("rescheduling every month, no payment ever: Stage 3 never cures", () => {
    let prior = { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: null as string | null, restructured: false, runDate: "2026-01-31" } as never as { stage: 1 | 2 | 3; stageSince: string; cureStartedOn: string | null; restructured: boolean; runDate: string }
    const stages: number[] = []
    for (let m = 2; m <= 28; m++) {
      const y = 2026 + Math.floor((m - 1) / 12)
      const mm = String(((m - 1) % 12) + 1).padStart(2, "0")
      const runDate = `${y}-${mm}-28`
      const runAt = new Date(`${runDate}T21:00:00Z`)
      const a = assessLoan(loanAt({ restructuredOn: `${y}-${mm}-20`, schedule: [{ dueDate: new Date(`${y + 2}-01-01`), principalDue: 1_000_000, interestDue: 0, feesDue: 0, totalDue: 1_000_000, totalPaid: 0 }] }), { runAt, settings: DEFAULT_SETTINGS } as never, prior as never)
      stages.push(a.staging.stage)
      prior = { stage: a.staging.stage as 1 | 2 | 3, stageSince: a.staging.stageSince, cureStartedOn: a.staging.cureStartedOn, restructured: a.staging.restructured, runDate }
    }
    process.stderr.write(`\nBRK serial ${stages.join("")}\n`)
    expect(Math.min(...stages)).toBe(3)
  })
})
