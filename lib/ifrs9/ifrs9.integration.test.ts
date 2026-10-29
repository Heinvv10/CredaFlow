/**
 * Real-Postgres proof of IFRS 9 staging, ECL and the rules the database holds: a loan walks Stage 1 -> 2 -> 3 and back
 * through its probation with hand-calculated ECL at each run; runs and snapshots are append-only; a snapshot that
 * disagrees with PD x LGD x EAD cannot be stored; a MONTHLY run exists once a month; one lender never sees another's.
 *
 *   RUN_IFRS9_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/ifrs9/ifrs9.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { Ifrs9RunError, executeRun } from "./run"
import { loadRunReport } from "./run-report"
import { clearSicrFlag, replaceParameters, saveSettings, setSicrFlag } from "./store"
import { DEFAULT_SETTINGS, type EclParameter } from "./types"

const suite = process.env.RUN_IFRS9_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const actorOf = (t: ChargesTenant) => ({ id: t.userId, email: "ifrs9-it@test.invalid" })
const at = (iso: string) => new Date(`${iso}T12:00:00+02:00`)

const PARAMETERS: EclParameter[] = [
  { scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 },
  { scopeKey: "DEFAULT", stage: 2, pdBps: 1500, lgdBps: 5000 },
  { scopeKey: "DEFAULT", stage: 3, pdBps: 10_000, lgdBps: 6000 },
]

async function lender(): Promise<ChargesTenant & { loanId: string }> {
  const tenant = await createChargesTenant(db, false)
  const loan = await createChargesLoan(db, tenant)
  // R2 000 over two instalments: R1 000 + R100 interest + R69 fees due 1 Sep 2026, R1 000 + R50 interest due 1 Dec 2027.
  await db.repaymentSchedule.updateMany({ where: { loanId: loan.loanId }, data: { principalDue: 100_000, interestDue: 10_000, feesDue: 6_900, totalDue: 116_900 } })
  await db.repaymentSchedule.create({
    data: { tenantId: tenant.tenantId, loanId: loan.loanId, installmentNo: 2, dueDate: new Date("2027-12-01T10:00:00+02:00"), principalDue: 100_000, interestDue: 5_000, feesDue: 0, totalDue: 105_000 },
  })
  return { ...tenant, loanId: loan.loanId }
}

const asTenant = <T>(t: ChargesTenant, fn: () => Promise<T>) => runWithTenant(t.tenantId, fn)
const configure = (t: ChargesTenant, over: Partial<typeof DEFAULT_SETTINGS> = {}) =>
  asTenant(t, async () => {
    await saveSettings(prisma, t.tenantId, { ...DEFAULT_SETTINGS, enabled: true, ...over }, actorOf(t))
    await replaceParameters(prisma, t.tenantId, PARAMETERS, actorOf(t))
  })
const snapshotOf = (runId: string, loanId: string) => db.ifrs9LoanSnapshot.findUniqueOrThrow({ where: { runId_loanId: { runId, loanId } } })

let a: Awaited<ReturnType<typeof lender>>
let b: Awaited<ReturnType<typeof lender>>

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

  it("walks a loan Stage 1 -> 2 -> 3 with the ECL worked out by hand, suspending interest in Stage 3", async () => {
    // 20 Sep 2026: instalment 1 (due 1 Sep) is 19 days past due. Raised and unpaid: R100 interest + R69 fees.
    // Accrued on instalment 2: R50 x 19/456 (1 Sep 2026 -> 1 Dec 2027 is 456 days) = 208.3 -> 208.
    const r1 = await asTenant(a, () => executeRun(a.tenantId, { kind: "ON_DEMAND", now: at("2026-09-20"), actor: actorOf(a) }))
    const s1 = await snapshotOf(r1.runId, a.loanId)
    expect(s1).toMatchObject({ daysPastDue: 19, stage: 1, previousStage: null, unpaidInterestCents: 10_000, unpaidFeesCents: 6_900, accruedInterestCents: 208, interestSuspended: false })
    // EAD = 200 000 + 10 000 + 6 900 + 208 = 217 108; ECL = 217 108 x 2% x 45% = 1 953.97
    expect(s1.eadCents).toBe(217_108)
    expect(s1.eclCents).toBe(1_954)

    // 15 Oct: 44 days past due -> Stage 2 (more than 30). Accrued 5 000 x 44/456 = 482.46 -> 482.
    const r2 = await asTenant(a, () => executeRun(a.tenantId, { kind: "ON_DEMAND", now: at("2026-10-15"), actor: actorOf(a) }))
    const s2 = await snapshotOf(r2.runId, a.loanId)
    expect(s2).toMatchObject({ daysPastDue: 44, stage: 2, previousStage: 1, reasons: ["DPD_OVER_SICR_THRESHOLD"], accruedInterestCents: 482 })
    // EAD = 216 900 + 482 = 217 382; ECL = 217 382 x 15% x 50% = 16 303.65
    expect(s2.eadCents).toBe(217_382)
    expect(s2.eclCents).toBe(16_304)

    // 5 Dec: 95 days past due -> Stage 3, interest suspended, nothing further accrued.
    const r3 = await asTenant(a, () => executeRun(a.tenantId, { kind: "ON_DEMAND", now: at("2026-12-05"), actor: actorOf(a) }))
    const s3 = await snapshotOf(r3.runId, a.loanId)
    expect(s3).toMatchObject({
      daysPastDue: 95, stage: 3, previousStage: 2, interestSuspended: true, suspendedInterestCents: 10_000, suspendedDefaultInterestCents: 0, accruedInterestCents: 0,
    })
    // EAD = 200 000 + 10 000 + 6 900 - 10 000 = 206 900; ECL = 206 900 x 100% x 60% = 124 140
    expect(s3.eadCents).toBe(206_900)
    expect(s3.eclCents).toBe(124_140)
    expect(s3.stageSince.toISOString().slice(0, 10)).toBe("2026-12-05")

    const report = await asTenant(a, () => loadRunReport(prisma, a.tenantId, r3.runId, r2.runId))
    expect(report?.transitions).toMatchObject({ deteriorated: 1, improved: 0, unchanged: 0 })
    expect(report?.transitions?.cells).toEqual([{ from: "2", to: "3", loans: 1, fromEadCents: 217_382, toEadCents: 206_900 }])
    expect(report?.summary.byStage[2]).toMatchObject({ loans: 1, eadCents: 206_900, eclCents: 124_140, coverageBps: 6000, suspendedCents: 10_000 })
  })

  it("holds Stage 3 through the six-month probation after the arrears are paid, then steps down to Stage 2 and on to Stage 1", async () => {
    // 20 Dec: instalment 1 paid in full (R1 169), principal down to R1 000.
    await db.repaymentSchedule.updateMany({ where: { loanId: a.loanId, installmentNo: 1 }, data: { totalPaid: 116_900, status: "PAID" } })
    await db.loan.update({ where: { id: a.loanId }, data: { outstandingPrincipal: 100_000 } })
    const run = (iso: string) => asTenant(a, () => executeRun(a.tenantId, { kind: "ON_DEMAND", now: at(iso), actor: actorOf(a) }))

    const cured = await snapshotOf((await run("2026-12-20")).runId, a.loanId)
    expect(cured).toMatchObject({ daysPastDue: 0, stage: 3, triggerStage: 1, reasons: ["PROBATION_FROM_STAGE_3"], interestSuspended: true, suspendedInterestCents: 0 })
    expect(cured.cureStartedOn?.toISOString().slice(0, 10)).toBe("2026-12-20")
    // still Stage 3 on EAD 100 000 (no accrual while suspended): 100 000 x 100% x 60%
    expect(cured.eclCents).toBe(60_000)

    const held = await snapshotOf((await run("2027-06-19")).runId, a.loanId)
    expect(held.stage).toBe(3)

    // 20 Jun 2027 is six months after 20 Dec: Stage 2, interest no longer suspended, and the Stage 2 probation (3 months) starts.
    const stepped = await snapshotOf((await run("2027-06-20")).runId, a.loanId)
    expect(stepped).toMatchObject({ stage: 2, previousStage: 3, interestSuspended: false })
    expect(stepped.cureStartedOn?.toISOString().slice(0, 10)).toBe("2027-06-20")
    // accrued on instalment 2: 5 000 x 292/456 = 3 201.75 -> 3 202; EAD 103 202; ECL = 103 202 x 15% x 50% = 7 740.15
    expect(stepped).toMatchObject({ accruedInterestCents: 3_202, eadCents: 103_202, eclCents: 7_740 })

    const back = await snapshotOf((await run("2027-09-20")).runId, a.loanId)
    expect(back).toMatchObject({ stage: 1, previousStage: 2, cureStartedOn: null })
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

  it("refuses a snapshot whose ECL is not EAD x PD x LGD, whose EAD is not the sum of its parts, or whose stage is out of range", async () => {
    const base = await db.ifrs9LoanSnapshot.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    const { id: _id, createdAt: _createdAt, ...row } = base
    const own = await db.ifrs9Run.create({ data: { tenantId: a.tenantId, kind: "ON_DEMAND", runDate: new Date("2026-01-01"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0 } })
    const mk = (over: Partial<typeof row>) => db.ifrs9LoanSnapshot.create({ data: { ...row, runId: own.id, ...over } })
    await expect(mk({ eclCents: row.eclCents + 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ eadCents: row.eadCents + 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ stage: 4 })).rejects.toThrow(/Ifrs9LoanSnapshot_stage_bounds/)
    await expect(mk({ triggerStage: 3, stage: 2 })).rejects.toThrow(/Ifrs9LoanSnapshot_stage_bounds/)
    await expect(mk({ interestSuspended: false, suspendedInterestCents: 1 })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
    await expect(mk({ suspendedInterestCents: row.unpaidInterestCents + 1, interestSuspended: true })).rejects.toThrow(/Ifrs9LoanSnapshot_figures/)
  })

  it("refuses a run whose kind and period disagree, an unbounded PD or policy, and a scope it does not know", async () => {
    const run = (over: Record<string, unknown>) => db.ifrs9Run.create({ data: { tenantId: a.tenantId, kind: "ON_DEMAND", runDate: new Date("2026-01-01"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0, ...over } })
    await expect(run({ periodKey: "2026-01" })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(run({ kind: "MONTHLY" })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(run({ kind: "MONTHLY", periodKey: "2026-13" })).rejects.toThrow(/Ifrs9Run_shape/)
    await expect(db.ifrs9EclParameter.create({ data: { tenantId: a.tenantId, scopeKey: "DEFAULT", stage: 1, pdBps: 10_001, lgdBps: 1 } })).rejects.toThrow(/Ifrs9EclParameter_bounds/)
    await expect(db.ifrs9EclParameter.create({ data: { tenantId: a.tenantId, scopeKey: "WHATEVER", stage: 1, pdBps: 1, lgdBps: 1 } })).rejects.toThrow(/Ifrs9EclParameter_bounds/)
    await expect(db.ifrs9Config.update({ where: { tenantId: a.tenantId }, data: { sicrDpdOver: 90 } })).rejects.toThrow(/Ifrs9Config_policy_bounds/)
  })

  it("makes one MONTHLY run per month: a second call, even from another replica at the same moment, returns the first", async () => {
    const now = new Date("2026-10-31T23:50:00+02:00")
    const [x, y] = await asTenant(b, () => Promise.all([
      executeRun(b.tenantId, { kind: "MONTHLY", now }),
      executeRun(b.tenantId, { kind: "MONTHLY", now }),
    ]))
    expect(x.runId).toBe(y.runId)
    expect([x.created, y.created].filter(Boolean)).toHaveLength(1)
    expect(await db.ifrs9Run.count({ where: { tenantId: b.tenantId, kind: "MONTHLY" } })).toBe(1)
    const run = await db.ifrs9Run.findUniqueOrThrow({ where: { id: x.runId } })
    expect(run).toMatchObject({ periodKey: "2026-10", loanCount: 1 })
    // 31 Oct: 60 days past due -> Stage 2. Accrued 5 000 x 60/456 = 657.9 -> 658, EAD 217 558; ECL = 217 558 x 15% x 50% = 16 316.85
    expect((await snapshotOf(x.runId, b.loanId)).eclCents).toBe(16_317)
  })

  it("makes up a missed month-end run in the first five days of the next month, and not later", async () => {
    const early = await asTenant(b, () => executeRun(b.tenantId, { kind: "MONTHLY", periodKey: "2026-10", now: at("2026-11-03") }))
    expect(early.created).toBe(false)
    await expect(asTenant(b, () => executeRun(b.tenantId, { kind: "MONTHLY", periodKey: "2026-10", now: at("2026-11-09") }))).rejects.toMatchObject({ code: "INVALID_PERIOD" })
  })

  it("keeps lenders apart: a run lists only its own loans and a report never reads another's run", async () => {
    const runs = await db.ifrs9Run.findMany({ where: { tenantId: b.tenantId } })
    const snapshots = await db.ifrs9LoanSnapshot.findMany({ where: { runId: { in: runs.map((r) => r.id) } } })
    expect(new Set(snapshots.map((s) => s.loanId))).toEqual(new Set([b.loanId]))
    const aRun = await db.ifrs9Run.findFirstOrThrow({ where: { tenantId: a.tenantId } })
    expect(await asTenant(b, () => loadRunReport(prisma, b.tenantId, aRun.id))).toBeNull()
  })

  it("refuses to run without a PD and LGD for every stage, or a monthly run for a lender that has not enabled IFRS 9", async () => {
    const c = await lender()
    await expect(asTenant(c, () => executeRun(c.tenantId, { kind: "MONTHLY", now: at("2026-10-31") }))).rejects.toMatchObject({ code: "NOT_ENABLED" })
    await asTenant(c, () => saveSettings(prisma, c.tenantId, { ...DEFAULT_SETTINGS, enabled: true }, actorOf(c)))
    const error = await asTenant(c, () => executeRun(c.tenantId, { kind: "ON_DEMAND", now: at("2026-10-31") })).catch((e) => e)
    expect(error).toBeInstanceOf(Ifrs9RunError)
    expect(error.code).toBe("PARAMETERS_MISSING")
    expect(await db.ifrs9Run.count({ where: { tenantId: c.tenantId } })).toBe(0)
  })

  it("puts a flagged loan in Stage 2 while the flag is active and into probation when it is cleared", async () => {
    const c = await lender()
    await configure(c, { stage2ProbationMonths: 3 })
    const run = (iso: string) => asTenant(c, () => executeRun(c.tenantId, { kind: "ON_DEMAND", now: at(iso), actor: actorOf(c) }))
    expect(await asTenant(c, () => setSicrFlag(prisma, c.tenantId, c.loanId, "BUREAU_DOWNGRADE", "Score fell 80 points", actorOf(c)))).toBe(true)
    // 1 Aug 2026: before the first instalment is due, so nothing is past due; the flag alone makes it Stage 2.
    const flagged = await snapshotOf((await run("2026-08-15")).runId, c.loanId)
    expect(flagged).toMatchObject({ daysPastDue: 0, stage: 2, reasons: ["FLAG_BUREAU_DOWNGRADE"] })
    const flag = await db.ifrs9SicrFlag.findFirstOrThrow({ where: { loanId: c.loanId } })
    expect(await asTenant(c, () => clearSicrFlag(prisma, c.tenantId, flag.id, actorOf(c)))).toBe(true)
    expect(await asTenant(c, () => clearSicrFlag(prisma, c.tenantId, flag.id, actorOf(c))), "already cleared").toBe(false)
    const probation = await snapshotOf((await run("2026-08-20")).runId, c.loanId)
    expect(probation).toMatchObject({ stage: 2, triggerStage: 1, reasons: ["PROBATION_FROM_STAGE_2"] })
    expect(await asTenant(c, () => setSicrFlag(prisma, c.tenantId, b.loanId, "WATCHLIST", "not this lender's loan", actorOf(c))), "another lender's loan").toBe(false)
    const audits = await db.auditLog.findMany({ where: { tenantId: c.tenantId, action: { in: ["IFRS9_SICR_FLAG_SET", "IFRS9_SICR_FLAG_CLEARED", "IFRS9_RUN_CREATED", "IFRS9_SETTINGS_UPDATED", "IFRS9_PARAMETERS_REPLACED"] } } })
    expect(new Set(audits.map((x) => x.action))).toEqual(new Set(["IFRS9_SICR_FLAG_SET", "IFRS9_SICR_FLAG_CLEARED", "IFRS9_RUN_CREATED", "IFRS9_SETTINGS_UPDATED", "IFRS9_PARAMETERS_REPLACED"]))
  })
})
