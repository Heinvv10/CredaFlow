/**
 * Real-Postgres proof of the monthly run's lifecycle: one original per month, a make-up run is the month-end position
 * rebuilt from the receipts live that day, a month's run is corrected by superseding it while the month is open.
 *
 *   RUN_IFRS9_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/ifrs9/ifrs9-runs.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as loanInput from "./loan-input"
import { prisma } from "@/lib/prisma"
import { currentMonthlyRun, executeRun } from "./run"
import { listRuns, loadOfficialMonthly, loadRunReport } from "./run-report"
import { replaceParameters, setSicrFlag } from "./store"
import { createChargesLoan } from "@/lib/loan/charges.integration-fixture"
import { PARAMETERS, RUN, actorOf, asTenant, at, configure, db, lender, monthEnd, monthly, onDemand, snapshotOf, ymd, type Lender } from "./ifrs9.integration-fixture"

const suite = RUN ? describe : describe.skip

let b: Lender

suite.sequential("IFRS 9 monthly runs (real Postgres)", () => {
  beforeAll(async () => {
    b = await lender()
    await configure(b)
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("makes one original MONTHLY run per month: a second call, even from another replica at the same moment, returns the first", async () => {
    const now = monthEnd("2026-10-31")
    const [x, y] = await asTenant(b, () => Promise.all([
      executeRun(b.tenantId, { kind: "MONTHLY", periodKey: "2026-10", now }),
      executeRun(b.tenantId, { kind: "MONTHLY", periodKey: "2026-10", now }),
    ]))
    expect(x.runId).toBe(y.runId)
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1)
    expect(await db.ifrs9Run.count({ where: { tenantId: b.tenantId, kind: "MONTHLY" } })).toBe(1)
    const run = await db.ifrs9Run.findUniqueOrThrow({ where: { id: x.runId } })
    expect(run).toMatchObject({ periodKey: "2026-10", loanCount: 1, late: false })
    // 31 Oct: 60 days past due -> Stage 2: EAD 217 558 ; ECL = 217 558 x 15% x 50% = 16 316.85
    expect((await snapshotOf(x.runId, b.loanId)).eclCents).toBe(16_317)
  })

  it("makes up a missed month-end run as the month-end position, rebuilt from the receipts live that day (late, not today's)", async () => {
    const c = await lender()
    await configure(c)
    // 2 Nov: the borrower pays instalment 1 (R1 169). The stored schedule now says paid.
    await db.payment.create({ data: { tenantId: c.tenantId, loanId: c.loanId, amount: 116_900, receivedAt: new Date("2026-11-02T10:00:00+02:00") } })
    await db.repaymentSchedule.updateMany({ where: { loanId: c.loanId, installmentNo: 1 }, data: { totalPaid: 116_900, status: "PAID" } })
    await db.loan.update({ where: { id: c.loanId }, data: { outstandingPrincipal: 100_000 } })

    const made = await monthly(c, "2026-10", at("2026-11-03"))
    expect(made).toMatchObject({ created: true, late: true, runDate: "2026-10-31", periodKey: "2026-10" })
    const s = await snapshotOf(made.runId, c.loanId)
    // October's position, identical to what the 31 Oct job would have stored: 60 days past due, Stage 2, R2 000 principal still owed
    expect(s).toMatchObject({ daysPastDue: 60, stage: 2, outstandingPrincipalCents: 200_000, unpaidInterestCents: 10_000, eadCents: 217_558, eclCents: 16_317 })
    expect(ymd(s.runDate)).toBe("2026-10-31")
    expect(await db.ifrs9Run.findUniqueOrThrow({ where: { id: made.runId } })).toMatchObject({ late: true })
  })

  it("supersedes a month's run while it is open: the replaced run stays, the new one is the month's run, each run is replaced at most once", async () => {
    const d = await lender()
    await configure(d)
    const original = await monthly(d, "2026-10", monthEnd("2026-10-31"))
    expect((await asTenant(d, () => currentMonthlyRun(prisma, d.tenantId, "2026-10")))?.id).toBe(original.runId)
    await asTenant(d, () => replaceParameters(prisma, d.tenantId, PARAMETERS.map((p) => (p.stage === 2 ? { ...p, pdBps: 2000 } : p)), actorOf(d)))

    const replacement = await monthly(d, "2026-10", at("2026-11-04"), { supersede: { runId: original.runId, reason: "Stage 2 PD corrected to 20%" } })
    expect(replacement.created).toBe(true)
    expect((await asTenant(d, () => currentMonthlyRun(prisma, d.tenantId, "2026-10")))?.id).toBe(replacement.runId)
    expect(await db.ifrs9Run.findUniqueOrThrow({ where: { id: original.runId } })).toMatchObject({ loanCount: 1 })
    // 217 558 x 20% x 50% = 21 755.8
    expect((await snapshotOf(replacement.runId, d.loanId)).eclCents).toBe(21_756)
    expect(await db.ifrs9Run.findUniqueOrThrow({ where: { id: replacement.runId } })).toMatchObject({ supersedesRunId: original.runId, reason: "Stage 2 PD corrected to 20%", late: true })

    // reports default to the month's current run and skip the one it replaced
    expect((await asTenant(d, () => loadRunReport(prisma, d.tenantId)))?.run).toMatchObject({ id: replacement.runId, superseded: false, late: true })
    expect((await asTenant(d, () => loadRunReport(prisma, d.tenantId, original.runId)))?.run).toMatchObject({ superseded: true })

    // the original is no longer the month's run: naming it again is stale, and the database refuses a second successor
    await expect(monthly(d, "2026-10", at("2026-11-05"), { supersede: { runId: original.runId, reason: "again" } })).rejects.toMatchObject({ code: "SUPERSEDE_STALE" })
    await expect(db.ifrs9Run.create({
      data: { tenantId: d.tenantId, kind: "MONTHLY", periodKey: "2026-10", runDate: new Date("2026-10-31"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0, supersedesRunId: original.runId, reason: "fork" },
    })).rejects.toThrow()
    // a second original for the month is refused, a supersede needs a reason and the same month
    const raw = (over: Record<string, unknown>) => db.ifrs9Run.create({
      data: { tenantId: d.tenantId, kind: "MONTHLY", periodKey: "2026-10", runDate: new Date("2026-10-31"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0, ...over },
    })
    await expect(raw({})).rejects.toThrow()
    await expect(raw({ supersedesRunId: replacement.runId })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(raw({ periodKey: "2026-11", runDate: new Date("2026-11-30"), supersedesRunId: replacement.runId, reason: "wrong month" })).rejects.toThrow(/same month/)
  })

  it("starts the next month from the run that replaced a month's run, never from the superseded one", async () => {
    const e = await lender()
    await configure(e)
    const sep = await monthly(e, "2026-09", monthEnd("2026-09-30"))
    expect((await snapshotOf(sep.runId, e.loanId)).stage).toBe(1)
    // a watchlist flag that was missed is entered; the September run is redone with it
    await asTenant(e, () => setSicrFlag(prisma, e.tenantId, e.loanId, "WATCHLIST", "on the bureau watchlist at 30 Sep", actorOf(e)))
    const fixed = await monthly(e, "2026-09", at("2026-10-02"), { supersede: { runId: sep.runId, reason: "watchlist flag entered late" } })
    expect(await snapshotOf(fixed.runId, e.loanId)).toMatchObject({ stage: 2, reasons: ["FLAG_WATCHLIST"], previousStage: null })
    // October (60 days past due) starts from the corrected September: Stage 2 -> Stage 2, since 30 Sep, not 31 Oct
    const oct = await snapshotOf((await monthly(e, "2026-10", monthEnd("2026-10-31"))).runId, e.loanId)
    expect(oct).toMatchObject({ stage: 2, previousStage: 2 })
    expect(ymd(oct.stageSince)).toBe("2026-09-30")
  })

  it("refuses a monthly run for a month that has not ended, an invalid month, or without IFRS 9 enabled", async () => {
    const f = await lender()
    await expect(asTenant(f, () => executeRun(f.tenantId, { kind: "MONTHLY", periodKey: "2026-10", now: at("2026-10-31") }))).rejects.toMatchObject({ code: "NOT_ENABLED" })
    await configure(f)
    await expect(monthly(f, "2026-10", at("2026-10-30"))).rejects.toMatchObject({ code: "PERIOD_NOT_ENDED" })
    await expect(monthly(f, "2026-13", at("2027-01-30"))).rejects.toMatchObject({ code: "INVALID_PERIOD" })
  })

  // Review breaker 3a (PR #255 round 2): a make-up run for October is October's book, not the book on the day it was made.
  it("leaves a loan disbursed after the month end out of that month's make-up run", async () => {
    const a = await lender()
    await configure(a)
    const later = await createChargesLoan(db, a)
    await db.loan.update({ where: { id: later.loanId }, data: { startDate: at("2026-11-02"), maturityDate: at("2026-12-02") } })
    await db.repaymentSchedule.updateMany({ where: { loanId: later.loanId }, data: { dueDate: at("2026-12-02") } })
    const run = await monthly(a, "2026-10", at("2026-11-03"))
    expect(run.loanCount).toBe(1)
    expect(await db.ifrs9LoanSnapshot.findFirst({ where: { runId: run.runId, loanId: later.loanId } })).toBeNull()
    expect(await db.ifrs9LoanSnapshot.findFirst({ where: { runId: run.runId, loanId: a.loanId } })).not.toBeNull()
  })

  // Review breakers 3a and 3c: a loan that exited after the month end was on that month's book, one that exited before was not.
  it("keeps a loan written off after the month end in that month's make-up run, staged on its days past due then, and drops one written off before", async () => {
    const c = await lender()
    await configure(c)
    const before = await createChargesLoan(db, c)
    await monthly(c, "2026-10", monthEnd("2026-10-31"))
    await db.loan.update({ where: { id: c.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: at("2026-12-02"), closedAt: at("2026-12-02") } })
    await db.loan.update({ where: { id: before.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: at("2026-11-20"), closedAt: at("2026-11-20") } })
    const nov = await monthly(c, "2026-11", at("2026-12-03"))
    expect(nov.loanCount).toBe(1)
    const s = await snapshotOf(nov.runId, c.loanId)
    // 90 days past due on 30 Nov (due 1 Sep): Stage 3, with the interest suspended, although the loan has since been written off
    expect(s).toMatchObject({ daysPastDue: 90, stage: 3, interestSuspended: true, loanStatus: "ACTIVE", eclCents: 124_140 })
    expect(await db.ifrs9LoanSnapshot.findFirst({ where: { runId: nov.runId, loanId: before.loanId } })).toBeNull()
  })

  it("refuses a month's first run while the month before it, which IFRS 9 governs, has none; and does not ask for a month it does not govern", async () => {
    const g = await lender()
    await configure(g, { effectiveFromMonth: "2026-10" })
    await expect(monthly(g, "2026-11", monthEnd("2026-11-30"))).rejects.toMatchObject({ code: "PREVIOUS_MONTH_MISSING" })
    await monthly(g, "2026-10", monthEnd("2026-10-31"))
    expect((await monthly(g, "2026-11", monthEnd("2026-11-30"))).created).toBe(true)
    const h = await lender()
    await configure(h, { effectiveFromMonth: "2026-11" })
    expect((await monthly(h, "2026-11", monthEnd("2026-11-30"))).created).toBe(true)
  })

  it("lets a late October run be made after November's: allowed, because the close then holds November as stale", async () => {
    const i = await lender()
    await configure(i)
    const nov = await monthly(i, "2026-11", monthEnd("2026-11-30"))
    const oct = await monthly(i, "2026-10", at("2026-12-02"), { lateReason: "job down" })
    expect(new Date((await db.ifrs9Run.findUniqueOrThrow({ where: { id: oct.runId } })).createdAt).getTime())
      .toBeGreaterThan(new Date((await db.ifrs9Run.findUniqueOrThrow({ where: { id: nov.runId } })).createdAt).getTime())
  })

  it("answers a concurrent double supersede with one new run and one SUPERSEDE_STALE", async () => {
    const j = await lender()
    await configure(j)
    const original = await monthly(j, "2026-10", monthEnd("2026-10-31"))
    const results = await Promise.allSettled([1, 2].map((n) => monthly(j, "2026-10", at("2026-11-04"), { supersede: { runId: original.runId, reason: `fix ${n}` } })))
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1)
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult
    expect(failed.reason).toMatchObject({ code: "SUPERSEDE_STALE" })
    expect(await db.ifrs9Run.count({ where: { tenantId: j.tenantId, supersedesRunId: original.runId } })).toBe(1)
  })

  it("refuses a run whose prior month's run was replaced while it was being worked out, and makes it on the new one when retried", async () => {
    const r = await lender()
    await configure(r)
    const sep = await monthly(r, "2026-09", monthEnd("2026-09-30"))
    const oct = await monthly(r, "2026-10", monthEnd("2026-10-31"))
    const real = loanInput.loadPriorStaging
    let interleaved = false
    const spy = vi.spyOn(loanInput, "loadPriorStaging").mockImplementation(async (...args) => {
      const priors = await real(...args)
      if (!interleaved) {
        interleaved = true
        // September is replaced after October's run read its stages from the old September run
        await monthly(r, "2026-09", at("2026-11-04"), { supersede: { runId: sep.runId, reason: "corrected flags" } })
      }
      return priors
    })
    try {
      await expect(monthly(r, "2026-10", at("2026-11-04"), { supersede: { runId: oct.runId, reason: "fix" } })).rejects.toMatchObject({ code: "CHAIN_CHANGED" })
    } finally {
      spy.mockRestore()
    }
    expect(await db.ifrs9Run.count({ where: { tenantId: r.tenantId, supersedesRunId: oct.runId } })).toBe(0)
    const retried = await monthly(r, "2026-10", at("2026-11-04"), { supersede: { runId: oct.runId, reason: "fix" } })
    expect(retried.created).toBe(true)
  })

  it("refuses a monthly run for a month before the one IFRS 9 takes effect", async () => {
    const e = await lender()
    await configure(e, { effectiveFromMonth: "2026-10" })
    await expect(monthly(e, "2026-09", monthEnd("2026-09-30"))).rejects.toMatchObject({ code: "NOT_EFFECTIVE" })
    expect(await db.ifrs9Run.count({ where: { tenantId: e.tenantId } })).toBe(0)
  })

  it("carries the restructured marker from one month's run to the next through the database", async () => {
    const k = await lender()
    await configure(k)
    await db.loan.update({ where: { id: k.loanId }, data: { status: "RESTRUCTURED" } })
    const sep = await snapshotOf((await monthly(k, "2026-09", monthEnd("2026-09-30"))).runId, k.loanId)
    expect(sep).toMatchObject({ stage: 2, restructured: true, reasons: ["RESTRUCTURED"] })
    // the arrangement is kept: the arrears are paid and the loan is ACTIVE again, but it serves the longer restructure probation
    await db.repaymentSchedule.updateMany({ where: { loanId: k.loanId, installmentNo: 1 }, data: { totalPaid: 116_900, status: "PAID" } })
    await db.loan.update({ where: { id: k.loanId }, data: { status: "ACTIVE", outstandingPrincipal: 100_000 } })
    const oct = await snapshotOf((await monthly(k, "2026-10", monthEnd("2026-10-31"))).runId, k.loanId)
    expect(oct).toMatchObject({ stage: 2, triggerStage: 1, restructured: true, reasons: ["PROBATION_FROM_STAGE_2", "RESTRUCTURE_PROBATION"] })
  })
})
