/**
 * Real-Postgres proof of the monthly run's lifecycle: one original per month, a make-up run is the month-end position
 * rebuilt from the receipts live that day, a month's run is corrected by superseding it while the month is open.
 *
 *   RUN_IFRS9_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/ifrs9/ifrs9-runs.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { currentMonthlyRun, executeRun } from "./run"
import { loadRunReport } from "./run-report"
import { replaceParameters, setSicrFlag } from "./store"
import { PARAMETERS, RUN, actorOf, asTenant, at, configure, db, lender, monthEnd, monthly, snapshotOf, ymd, type Lender } from "./ifrs9.integration-fixture"

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
})
