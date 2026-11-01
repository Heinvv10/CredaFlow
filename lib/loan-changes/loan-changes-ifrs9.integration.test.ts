/**
 * Real-Postgres proof of the marker of a loan in default at a restructure, through real change routes and real IFRS 9 runs:
 * it holds until a MONTHLY run has staged the loan at 3, and is spent after.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/
 *
 * Its own throwaway database, a Lesotho instance: the role needs CREATEDB. Each loan is its own lender, so each has its own runs.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true } }))
vi.mock("@/lib/prisma", async (original) => ({
  ...(await original<typeof import("@/lib/prisma")>()),
  prisma: new Proxy({}, { get: (_t, key) => (holder.prisma as Record<string | symbol, unknown>)[key] }),
}))
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: holder.user })),
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => await runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId })),
}))

import { createAppPrismaClient, prisma } from "@/lib/prisma"
import { periodEndDate } from "@/lib/ifrs9/period"
import { executeRun } from "@/lib/ifrs9/run"
import { replaceParameters, saveSettings } from "@/lib/ifrs9/store"
import { DEFAULT_SETTINGS, type Ifrs9Settings } from "@/lib/ifrs9/types"
import { addCalendarMonths } from "@/lib/product-engine/periods"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { proposeAndApprove } = changeRoutes(holder)

/** A month after this one: never the day of the change, whatever day the suite runs on. */
const monthAhead = (months: number) => sastCalendarDate(addCalendarMonths(new Date(), months)).slice(0, 7)
const monthEnd = (periodKey: string) => new Date(`${periodEndDate(periodKey)}T23:50:00+02:00`)

suite("the default marker and the IFRS 9 run (real Postgres, real runs, a Lesotho instance)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  const actor = (l: LoanFixture) => ({ id: l.checkerId, email: "ifrs9@test.invalid" })
  const defaulted = async (over: Partial<Ifrs9Settings> = {}) => {
    const l = await bookLoan(db(), { status: "DEFAULTED", monthsRun: 4, instalments: 18 })
    await runWithTenant(l.tenantId, async () => {
      await saveSettings(prisma, l.tenantId, { ...DEFAULT_SETTINGS, enabled: true, ...over }, actor(l))
      await replaceParameters(prisma, l.tenantId, [
        { scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 }, { scopeKey: "DEFAULT", stage: 2, pdBps: 1500, lgdBps: 5000 }, { scopeKey: "DEFAULT", stage: 3, pdBps: 10_000, lgdBps: 6000 },
      ], actor(l))
    })
    return l
  }
  /** Past the last month the suite runs, so nothing falls due in a run and its stage is the marker's. */
  const reschedulePastTheRuns = async (l: LoanFixture) => {
    const clear = new Date(`${periodEndDate(monthAhead(3))}T23:59:00+02:00`)
    const row = await db().repaymentSchedule.findFirstOrThrow({ where: { loanId: l.loanId, dueDate: { gt: clear } }, orderBy: { dueDate: "asc" } })
    await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: sastCalendarDate(row.dueDate) })
  }
  const monthly = async (l: LoanFixture, periodKey: string, supersede?: { runId: string; reason: string }) => {
    const run = await runWithTenant(l.tenantId, () => executeRun(l.tenantId, { kind: "MONTHLY", periodKey, now: monthEnd(periodKey), actor: actor(l), supersede }))
    const snapshot = await db().ifrs9LoanSnapshot.findUniqueOrThrow({ where: { runId_loanId: { runId: run.runId, loanId: l.loanId } } })
    return { runId: run.runId, stage: snapshot.stage, reasons: snapshot.reasons }
  }
  const row = (l: LoanFixture) => db().loan.findUniqueOrThrow({ where: { id: l.loanId } })

  it("a change before any run keeps the marker, an ON_DEMAND run does not spend it, and the MONTHLY run stages the loan at 3", async () => {
    const l = await defaulted()
    await reschedulePastTheRuns(l)
    await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    expect(await row(l)).toMatchObject({ defaultedAtRestructure: true })
    const period = monthAhead(1)
    await runWithTenant(l.tenantId, () => executeRun(l.tenantId, { kind: "ON_DEMAND", now: monthEnd(period), actor: actor(l) }))
    const { restructuredAt } = await row(l)
    await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.029 })
    const still = await row(l)
    expect(still.defaultedAtRestructure).toBe(true)
    expect(still.restructuredAt!.getTime()).toBeGreaterThan(restructuredAt!.getTime())
    expect(await monthly(l, period)).toMatchObject({ stage: 3, reasons: ["RESTRUCTURED"] })
  })

  it("a cured loan with a rate cut stays where it is: the change is not a restructure, and the next run leaves its stage alone", async () => {
    const l = await defaulted({ stage2ProbationMonths: 0, stage3ProbationMonths: 0, restructuredProbationMonths: 0 })
    await reschedulePastTheRuns(l)
    expect(await monthly(l, monthAhead(1))).toMatchObject({ stage: 3, reasons: ["RESTRUCTURED"] })
    expect(await monthly(l, monthAhead(2))).toMatchObject({ stage: 1, reasons: [] })
    const { restructuredAt } = await row(l)
    await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    const after = await row(l)
    expect(after.interestRatePm.toString()).toBe("0.03")
    expect(after.restructuredAt).toEqual(restructuredAt)
    expect(await monthly(l, monthAhead(3))).toMatchObject({ stage: 1, reasons: [] })
  })

  it("a loan still curing keeps its Stage 3 hold through a rate cut, from its prior stage", async () => {
    const l = await defaulted()
    await reschedulePastTheRuns(l)
    await monthly(l, monthAhead(1))
    await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    const held = await monthly(l, monthAhead(2))
    expect(held.stage).toBe(3)
    expect(held.reasons).toContain("PROBATION_FROM_STAGE_3")
  })

  it("replacing the month's run stages the loan at 3 again: the marker is still there for it to read", async () => {
    const l = await defaulted()
    await reschedulePastTheRuns(l)
    const first = await monthly(l, monthAhead(1))
    expect(first.stage).toBe(3)
    expect(await monthly(l, monthAhead(1), { runId: first.runId, reason: "A corrected PD" })).toMatchObject({ stage: 3, reasons: ["RESTRUCTURED"] })
  })
})
