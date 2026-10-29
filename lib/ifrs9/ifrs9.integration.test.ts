/**
 * Real-Postgres proof of IFRS 9 staging, ECL and the rules the database holds: a loan walks Stage 1 -> 2 -> 3 and back
 * through its probation on month-end runs with hand-calculated ECL; on-demand runs feed nothing; runs and snapshots are
 * append-only; a snapshot that disagrees with PD x LGD x EAD cannot be stored.
 *
 *   RUN_IFRS9_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/ifrs9/ifrs9.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { prisma } from "@/lib/prisma"
import { Ifrs9RunError } from "./run"
import { loadRunReport } from "./run-report"
import { clearSicrFlag, saveSettings, setSicrFlag } from "./store"
import { DEFAULT_SETTINGS } from "./types"
import { RUN, actorOf, asTenant, at, configure, db, lender, monthEnd, monthly, onDemand, snapshotOf, ymd, type Lender } from "./ifrs9.integration-fixture"

const suite = RUN ? describe : describe.skip

let a: Lender
let b: Lender

suite.sequential("IFRS 9 (real Postgres)", () => {
  beforeAll(async () => {
    ;[a, b] = [await lender(), await lender()]
    await configure(a)
    await configure(b)
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("walks a loan Stage 1 -> 2 -> 3 on month-end runs with the ECL worked out by hand, and an on-demand run feeds nothing", async () => {
    // 30 Sep 2026: instalment 1 (due 1 Sep) is 29 days past due. Raised and unpaid: R100 interest + R69 fees.
    // Accrued on instalment 2: R50 x 29/456 (1 Sep 2026 -> 1 Dec 2027 is 456 days) = 318.0 -> 318.
    const sep = await monthly(a, "2026-09", monthEnd("2026-09-30"))
    const s1 = await snapshotOf(sep.runId, a.loanId)
    expect(s1).toMatchObject({ daysPastDue: 29, stage: 1, previousStage: null, unpaidInterestCents: 10_000, unpaidFeesCents: 6_900, accruedInterestCents: 318, interestSuspended: false })
    expect(ymd(s1.runDate)).toBe("2026-09-30")
    // EAD = 200 000 + 10 000 + 6 900 + 318 = 217 218 ; ECL = 217 218 x 2% x 45% = 1 954.96
    expect(s1.eadCents).toBe(217_218)
    expect(s1.eclCents).toBe(1_955)

    // Someone presses "run" on 15 Oct (44 days past due -> Stage 2): analysis only.
    const analysis = await onDemand(a, at("2026-10-15"))
    expect(await snapshotOf(analysis.runId, a.loanId)).toMatchObject({ stage: 2, previousStage: 1 })

    // 31 Oct: 60 days past due -> Stage 2. It starts from September's official run, not from the analysis.
    const oct = await monthly(a, "2026-10", monthEnd("2026-10-31"))
    const s2 = await snapshotOf(oct.runId, a.loanId)
    expect(s2).toMatchObject({ daysPastDue: 60, stage: 2, previousStage: 1, reasons: ["DPD_OVER_SICR_THRESHOLD"], accruedInterestCents: 658 })
    expect(ymd(s2.stageSince)).toBe("2026-10-31")
    // EAD = 216 900 + 5 000 x 60/456 (657.9 -> 658) = 217 558 ; ECL = 217 558 x 15% x 50% = 16 316.85
    expect(s2.eadCents).toBe(217_558)
    expect(s2.eclCents).toBe(16_317)

    // 30 Nov: 90 days past due -> Stage 3, interest suspended, nothing further accrued.
    const nov = await monthly(a, "2026-11", monthEnd("2026-11-30"))
    const s3 = await snapshotOf(nov.runId, a.loanId)
    expect(s3).toMatchObject({
      daysPastDue: 90, stage: 3, previousStage: 2, interestSuspended: true, suspensionBasis: "FULL_SUSPENSION",
      suspendedInterestCents: 10_000, suspendedDefaultInterestCents: 0, accruedInterestCents: 0,
    })
    // EAD = 200 000 + 10 000 + 6 900 - 10 000 = 206 900 ; ECL = 206 900 x 100% x 60% = 124 140
    expect(s3.eadCents).toBe(206_900)
    expect(s3.eclCents).toBe(124_140)

    const report = await asTenant(a, () => loadRunReport(prisma, a.tenantId, nov.runId, oct.runId))
    expect(report?.transitions).toMatchObject({ deteriorated: 1, improved: 0, unchanged: 0 })
    expect(report?.transitions?.cells).toEqual([{ from: "2", to: "3", loans: 1, fromEadCents: 217_558, toEadCents: 206_900 }])
    expect(report?.summary.byStage[2]).toMatchObject({ loans: 1, eadCents: 206_900, eclCents: 124_140, coverageBps: 6000, suspendedCents: 10_000 })
  })

  it("holds Stage 3 through the six-month probation after the arrears are paid, then steps down to Stage 2 and on to Stage 1", async () => {
    // Instalment 1 paid in full (R1 169) in December; principal down to R1 000.
    await db.repaymentSchedule.updateMany({ where: { loanId: a.loanId, installmentNo: 1 }, data: { totalPaid: 116_900, status: "PAID" } })
    await db.loan.update({ where: { id: a.loanId }, data: { outstandingPrincipal: 100_000 } })

    const dec = await snapshotOf((await monthly(a, "2026-12", monthEnd("2026-12-31"))).runId, a.loanId)
    expect(dec).toMatchObject({ daysPastDue: 0, stage: 3, triggerStage: 1, reasons: ["PROBATION_FROM_STAGE_3"], interestSuspended: true, suspendedInterestCents: 0 })
    expect(ymd(dec.cureStartedOn!)).toBe("2026-12-31")
    // still Stage 3 on EAD 100 000 (no accrual while suspended): 100 000 x 100% x 60%
    expect(dec.eclCents).toBe(60_000)

    expect((await snapshotOf((await monthly(a, "2027-05", monthEnd("2027-05-31"))).runId, a.loanId)).stage).toBe(3)

    // 30 Jun 2027 is six months after 31 Dec: Stage 2, interest no longer suspended, and the Stage 2 probation (3 months) starts.
    const jun = await snapshotOf((await monthly(a, "2027-06", monthEnd("2027-06-30"))).runId, a.loanId)
    expect(jun).toMatchObject({ stage: 2, previousStage: 3, interestSuspended: false })
    expect(ymd(jun.cureStartedOn!)).toBe("2027-06-30")
    // accrued on instalment 2: 5 000 x 302/456 = 3 311.4 -> 3 311 ; EAD 103 311 ; ECL = 103 311 x 15% x 50% = 7 748.3
    expect(jun).toMatchObject({ accruedInterestCents: 3_311, eadCents: 103_311, eclCents: 7_748 })

    expect(await snapshotOf((await monthly(a, "2027-09", monthEnd("2027-09-30"))).runId, a.loanId)).toMatchObject({ stage: 1, previousStage: 2, cureStartedOn: null })
  })

  it("on the net basis (IFRS 9 5.4.1(b)) keeps exposure gross and suspends the share of the interest the allowance covers", async () => {
    const n = await lender()
    await configure(n, { stage3InterestBasis: "NET_BASIS" })
    await monthly(n, "2026-09", monthEnd("2026-09-30"))
    await monthly(n, "2026-10", monthEnd("2026-10-31"))
    const s = await snapshotOf((await monthly(n, "2026-11", monthEnd("2026-11-30"))).runId, n.loanId)
    // gross EAD = 200 000 + 10 000 + 6 900 + 5 000 x 90/456 (986.8 -> 987) = 217 887 ; ECL = 217 887 x 100% x 60% = 130 732.2
    expect(s).toMatchObject({ stage: 3, interestSuspended: true, suspensionBasis: "NET_BASIS", accruedInterestCents: 987, eadCents: 217_887, eclCents: 130_732 })
    // coverage 130 732 / 217 887 = 60.0%: R100.00 of raised interest x that = 6 000
    expect(s.suspendedInterestCents).toBe(6_000)
  })

  it("is never edited: runs and snapshots refuse UPDATE, DELETE and TRUNCATE", async () => {
    const run = await db.ifrs9Run.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    await expect(db.ifrs9Run.update({ where: { id: run.id }, data: { loanCount: 99 } })).rejects.toThrow(/append-only/)
    await expect(db.ifrs9Run.delete({ where: { id: run.id } })).rejects.toThrow(/append-only/)
    const snapshot = await db.ifrs9LoanSnapshot.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    await expect(db.ifrs9LoanSnapshot.update({ where: { id: snapshot.id }, data: { eclCents: 1 } })).rejects.toThrow(/append-only/)
    await expect(db.ifrs9LoanSnapshot.deleteMany({ where: { tenantId: a.tenantId } })).rejects.toThrow(/append-only/)
    await expect(db.$executeRawUnsafe('TRUNCATE "Ifrs9LoanSnapshot"')).rejects.toThrow(/append-only/)
  })

  it("refuses a snapshot whose ECL is not EAD x PD x LGD, whose EAD is not the sum of its parts, or whose suspension does not follow its basis", async () => {
    const full = await db.ifrs9LoanSnapshot.findFirstOrThrow({ where: { tenantId: a.tenantId, interestSuspended: true } })
    const { id: _id, createdAt: _createdAt, ...row } = full
    const own = await db.ifrs9Run.create({ data: { tenantId: a.tenantId, kind: "ON_DEMAND", runDate: new Date("2026-01-01"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0 } })
    const mk = (over: Partial<typeof row>) => db.ifrs9LoanSnapshot.create({ data: { ...row, runId: own.id, ...over } })
    await expect(mk({ eclCents: row.eclCents + 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ eadCents: row.eadCents + 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ stage: 4 })).rejects.toThrow(/Ifrs9LoanSnapshot_stage_bounds/)
    await expect(mk({ triggerStage: 3, stage: 2 })).rejects.toThrow(/Ifrs9LoanSnapshot_stage_bounds/)
    await expect(mk({ interestSuspended: false, suspendedInterestCents: 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ suspendedInterestCents: row.unpaidInterestCents + 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    // a full-suspension snapshot suspends ALL the raised interest; a net-basis one only the share the allowance covers
    await expect(mk({ suspendedInterestCents: row.unpaidInterestCents - 1, eadCents: row.eadCents + 1, eclCents: Math.round((row.eadCents + 1) * 0.6) })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ suspensionBasis: "NET_BASIS" })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    // only a Stage 3 loan has its interest suspended
    await expect(mk({ stage: 2, triggerStage: 2 })).rejects.toThrow(/Ifrs9LoanSnapshot_stage_bounds/)
  })

  it("refuses a run whose shape is wrong, an unbounded PD or policy, and a Stage 3 PD below 100%", async () => {
    const run = (over: Record<string, unknown>) => db.ifrs9Run.create({ data: { tenantId: a.tenantId, kind: "ON_DEMAND", runDate: new Date("2026-01-01"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0, ...over } })
    await expect(run({ periodKey: "2026-01" })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(run({ kind: "MONTHLY" })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(run({ kind: "MONTHLY", periodKey: "2026-13" })).rejects.toThrow(/Ifrs9Run_shape/)
    // a MONTHLY run is dated its month's last day
    await expect(run({ kind: "MONTHLY", periodKey: "2026-01", runDate: new Date("2026-01-30") })).rejects.toThrow(/Ifrs9Run_shape/)
    // only a MONTHLY run is late or supersedes
    await expect(run({ late: true })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(db.ifrs9EclParameter.create({ data: { tenantId: a.tenantId, scopeKey: "DEFAULT", stage: 1, pdBps: 10_001, lgdBps: 1 } })).rejects.toThrow(/Ifrs9EclParameter_bounds/)
    await expect(db.ifrs9EclParameter.create({ data: { tenantId: a.tenantId, scopeKey: "WHATEVER", stage: 1, pdBps: 1, lgdBps: 1 } })).rejects.toThrow(/Ifrs9EclParameter_bounds/)
    await expect(db.ifrs9EclParameter.create({ data: { tenantId: a.tenantId, scopeKey: "PRODUCT:p9", stage: 3, pdBps: 9_999, lgdBps: 1 } })).rejects.toThrow(/Ifrs9EclParameter_bounds/)
    await expect(db.ifrs9Config.update({ where: { tenantId: a.tenantId }, data: { sicrDpdOver: 90 } })).rejects.toThrow(/Ifrs9Config_policy_bounds/)
    // interest is suspended only in Stage 3: the DPD threshold is never below the default threshold
    await expect(db.ifrs9Config.update({ where: { tenantId: a.tenantId }, data: { suspensionDpd: 60 } })).rejects.toThrow(/Ifrs9Config_policy_bounds/)
  })

  it("keeps lenders apart: a run lists only its own loans and a report never reads another's run", async () => {
    await monthly(b, "2026-10", monthEnd("2026-10-31"))
    const runs = await db.ifrs9Run.findMany({ where: { tenantId: b.tenantId } })
    const snapshots = await db.ifrs9LoanSnapshot.findMany({ where: { runId: { in: runs.map((r) => r.id) } } })
    expect(new Set(snapshots.map((s) => s.loanId))).toEqual(new Set([b.loanId]))
    const aRun = await db.ifrs9Run.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    expect(await asTenant(b, () => loadRunReport(prisma, b.tenantId, aRun.id))).toBeNull()
  })

  it("refuses to run without a PD and LGD for every stage", async () => {
    const c = await lender()
    await asTenant(c, () => saveSettings(prisma, c.tenantId, { ...DEFAULT_SETTINGS, enabled: true }, actorOf(c)))
    const error = await onDemand(c, at("2026-10-31")).catch((e) => e)
    expect(error).toBeInstanceOf(Ifrs9RunError)
    expect(error.code).toBe("PARAMETERS_MISSING")
    expect(await db.ifrs9Run.count({ where: { tenantId: c.tenantId } })).toBe(0)
  })

  it("puts a flagged loan in Stage 2 while the flag is active and into probation when it is cleared", async () => {
    const c = await lender()
    await configure(c, { stage2ProbationMonths: 3 })
    expect(await asTenant(c, () => setSicrFlag(prisma, c.tenantId, c.loanId, "BUREAU_DOWNGRADE", "Score fell 80 points", actorOf(c)))).toBe(true)
    // 31 Jul 2026: before the first instalment is due, so nothing is past due; the flag alone makes it Stage 2.
    const flagged = await snapshotOf((await monthly(c, "2026-07", monthEnd("2026-07-31"))).runId, c.loanId)
    expect(flagged).toMatchObject({ daysPastDue: 0, stage: 2, reasons: ["FLAG_BUREAU_DOWNGRADE"] })
    const flag = await db.ifrs9SicrFlag.findFirstOrThrow({ where: { loanId: c.loanId } })
    expect(await asTenant(c, () => clearSicrFlag(prisma, c.tenantId, flag.id, actorOf(c)))).toBe(true)
    expect(await asTenant(c, () => clearSicrFlag(prisma, c.tenantId, flag.id, actorOf(c))), "already cleared").toBe(false)
    const probation = await snapshotOf((await monthly(c, "2026-08", monthEnd("2026-08-31"))).runId, c.loanId)
    expect(probation).toMatchObject({ stage: 2, triggerStage: 1, reasons: ["PROBATION_FROM_STAGE_2"] })
    expect(await asTenant(c, () => setSicrFlag(prisma, c.tenantId, b.loanId, "WATCHLIST", "not this lender's loan", actorOf(c))), "another lender's loan").toBe(false)
    const audits = await db.auditLog.findMany({ where: { tenantId: c.tenantId, action: { in: ["IFRS9_SICR_FLAG_SET", "IFRS9_SICR_FLAG_CLEARED", "IFRS9_RUN_CREATED", "IFRS9_SETTINGS_UPDATED", "IFRS9_PARAMETERS_REPLACED"] } } })
    expect(new Set(audits.map((x) => x.action))).toEqual(new Set(["IFRS9_SICR_FLAG_SET", "IFRS9_SICR_FLAG_CLEARED", "IFRS9_RUN_CREATED", "IFRS9_SETTINGS_UPDATED", "IFRS9_PARAMETERS_REPLACED"]))
  })
})
