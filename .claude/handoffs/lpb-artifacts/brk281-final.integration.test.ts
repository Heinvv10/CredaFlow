/** Round 4 real-Postgres repros, head 4bfe04d5. RED = bug. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { runScreening } from "@/lib/screening/run"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true } }))
vi.mock("@/lib/prisma", async (original) => ({ ...(await original<typeof import("@/lib/prisma")>()), prisma: new Proxy({}, { get: (_t, key) => (holder.prisma as Record<string | symbol, unknown>)[key] }) }))
vi.mock("@/lib/auth-guards", async () => ({ requireApiRole: vi.fn(async () => ({ error: null, user: holder.user })), canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo }))
vi.mock("@/lib/tenant", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/tenant")>()), withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => await runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId })) }))

import { createAppPrismaClient } from "@/lib/prisma"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { inheritPriorStaging, loadRunLoans } from "@/lib/ifrs9/loan-input"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit, proposeAndApprove } = changeRoutes(holder)
const log = (l: string, v: unknown) => process.stderr.write(`\nBRK ${l} ${JSON.stringify(v)}\n`)
const nextDay = (d: Date) => new Date(d.getTime() + 2 * 3_600_000).toISOString().slice(0, 10)

suite("r4", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }); holder.prisma = createAppPrismaClient(fresh.url) }, 240_000)
  afterAll(() => fresh?.drop())
  const firstAhead = async (id: string) => nextDay((await db().repaymentSchedule.findFirstOrThrow({ where: { loanId: id, dueDate: { gt: new Date() } }, orderBy: { dueDate: "asc" } })).dueDate)
  const stageOf = async (l: LoanFixture, id: string, priors = new Map()) => {
    await inheritPriorStaging(db() as never, l.tenantId, priors)
    const loan = (await loadRunLoans(db() as never, l.tenantId, new Date(), null)).find((x) => x.id === id)!
    const a = assessLoan(loan, { runAt: new Date(), settings: DEFAULT_SETTINGS } as never, priors.get(id) ?? null)
    return { stage: a.staging.stage, flag: loan.defaultedAtRestructure, on: loan.restructuredOn }
  }

  it("a second forbearance before a run keeps defaultedAtRestructure", async () => {
    for (const second of [{ type: "RESTRUCTURE", instalments: 12 }, { type: "PAYMENT_HOLIDAY", holidayInstalments: 1 }]) {
      const l = await bookLoan(db(), { status: "DEFAULTED", monthsRun: 4 })
      await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: await firstAhead(l.loanId) })
      const one = await stageOf(l, l.loanId)
      await proposeAndApprove(l, second)
      const two = await stageOf(l, l.loanId)
      log("second", { second: second.type, one, two })
      expect(two.stage).toBe(3)
    }
  })

  it("a refinance straight after the reschedule keeps Stage 3", async () => {
    const l = await bookLoan(db(), { status: "DEFAULTED", monthsRun: 4 })
    await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: await firstAhead(l.loanId) })
    const id = await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })
    const newId = (await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })).newLoanId!
    const s = await stageOf(l, newId)
    log("refi", s)
    expect(s.stage).toBe(3)
  })

  it("final: a restructure after the Stage 3 run, then that month's run superseded, stays Stage 3", async () => {
    const l = await bookLoan(db(), { status: "DEFAULTED", monthsRun: 4 })
    const id = await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: await firstAhead(l.loanId) })
    const monthEnd = new Date("2026-10-31T00:00:00Z")
    // Throwaway database only: date the reschedule 20 Oct, which the DB default and triggers would not let a fixture do.
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.$executeRaw`UPDATE "LoanChange" SET "appliedAt" = '2026-10-20T10:00:00Z' WHERE "changeRequestId" = ${id}`
      await tx.$executeRaw`UPDATE "Loan" SET "restructuredAt" = '2026-10-20T10:00:00Z' WHERE "id" = ${l.loanId}`
    })
    const run = await db().ifrs9Run.create({ data: { tenantId: l.tenantId, kind: "MONTHLY", runDate: monthEnd, periodKey: "2026-10", late: true, reason: "Synthetic make-up run", settings: { x: 1 }, parameters: [{ x: 1 }], startedById: l.fx.tenant.userId, loanCount: 1, totalEadCents: 0, totalEclCents: 0 } })
    await db().ifrs9LoanSnapshot.create({ data: { tenantId: l.tenantId, runId: run.id, loanId: l.loanId, runDate: monthEnd, loanStatus: "ACTIVE", productId: l.fx.tenant.productId, contractType: "LOAN", daysPastDue: 0, stage: 3, triggerStage: 3, reasons: ["RESTRUCTURED"], stageSince: monthEnd, outstandingPrincipalCents: 1, unpaidInterestCents: 0, unpaidFeesCents: 0, chargesOutstandingCents: 0, accruedInterestCents: 0, interestSuspended: false, suspensionBasis: "FULL_SUSPENSION", suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, eadCents: 1, parameterScope: "DEFAULT", pdBps: 1, lgdBps: 1, eclCents: 0 } as never })
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12 })
    const flag = (await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).defaultedAtRestructure
    const runAt = new Date("2026-10-31T23:59:00+02:00")
    const asOf = new Date("2026-11-01T00:00:00+02:00")
    const row = (await loadRunLoans(db() as never, l.tenantId, runAt, asOf)).find((x) => x.id === l.loanId)!
    const priorSep = { stage: 2 as const, stageSince: "2026-09-30", cureStartedOn: null, restructured: false, runDate: "2026-09-30" }
    const a = assessLoan(row, { runAt, settings: DEFAULT_SETTINGS } as never, priorSep)
    log("superseded", { flag, status: row.status, stage: a.staging.stage, dpd: a.dpd, restructuredOn: row.restructuredOn, reasons: a.staging.reasons })
    expect(a.staging.stage).toBe(3)
  })

  it("final: an ON_DEMAND run does not spend the marker", async () => {
    const l = await bookLoan(db(), { status: "DEFAULTED", monthsRun: 4 })
    const id = await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: await firstAhead(l.loanId) })
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.$executeRaw`UPDATE "Loan" SET "restructuredAt" = '2026-10-20T10:00:00Z' WHERE "id" = ${l.loanId}`
    })
    void id
    const d = new Date("2026-10-31T00:00:00Z")
    const run = await db().ifrs9Run.create({ data: { tenantId: l.tenantId, kind: "ON_DEMAND", runDate: d, settings: { x: 1 }, parameters: [{ x: 1 }], startedById: l.fx.tenant.userId, loanCount: 1, totalEadCents: 0, totalEclCents: 0 } })
    await db().ifrs9LoanSnapshot.create({ data: { tenantId: l.tenantId, runId: run.id, loanId: l.loanId, runDate: d, loanStatus: "ACTIVE", productId: l.fx.tenant.productId, contractType: "LOAN", daysPastDue: 0, stage: 3, triggerStage: 3, reasons: [], stageSince: d, outstandingPrincipalCents: 1, unpaidInterestCents: 0, unpaidFeesCents: 0, chargesOutstandingCents: 0, accruedInterestCents: 0, interestSuspended: false, suspensionBasis: "FULL_SUSPENSION", suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, eadCents: 1, parameterScope: "DEFAULT", pdBps: 1, lgdBps: 1, eclCents: 0 } as never })
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12 })
    expect((await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).defaultedAtRestructure).toBe(true)
  })

  it("final: a cured loan's rate cut does not go back to Stage 3 or re-mark", async () => {
    const l = await bookLoan(db(), { status: "DEFAULTED", monthsRun: 4 })
    await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: await firstAhead(l.loanId) })
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.$executeRaw`UPDATE "Loan" SET "restructuredAt" = '2026-09-20T10:00:00Z' WHERE "id" = ${l.loanId}`
    })
    const d = new Date("2026-09-30T00:00:00Z")
    const run = await db().ifrs9Run.create({ data: { tenantId: l.tenantId, kind: "MONTHLY", runDate: d, periodKey: "2026-09", late: true, reason: "Synthetic make-up run", settings: { x: 1 }, parameters: [{ x: 1 }], startedById: l.fx.tenant.userId, loanCount: 1, totalEadCents: 0, totalEclCents: 0 } })
    await db().ifrs9LoanSnapshot.create({ data: { tenantId: l.tenantId, runId: run.id, loanId: l.loanId, runDate: d, loanStatus: "ACTIVE", productId: l.fx.tenant.productId, contractType: "LOAN", daysPastDue: 0, stage: 3, triggerStage: 3, reasons: [], stageSince: d, outstandingPrincipalCents: 1, unpaidInterestCents: 0, unpaidFeesCents: 0, chargesOutstandingCents: 0, accruedInterestCents: 0, interestSuspended: false, suspensionBasis: "FULL_SUSPENSION", suspendedInterestCents: 0, suspendedDefaultInterestCents: 0, eadCents: 1, parameterScope: "DEFAULT", pdBps: 1, lgdBps: 1, eclCents: 0 } as never })
    await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.02 })
    const row = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    log("rate cut", { restructuredAt: row.restructuredAt, flag: row.defaultedAtRestructure })
    expect(row.restructuredAt?.toISOString().slice(0, 10)).toBe("2026-09-20")
  })

  it("no application claims a change it is not", async () => {
    const a = await bookLoan(db()); const b = await bookLoan(db())
    const inPlace = await proposeAndApprove(a, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    const base = { tenantId: a.tenantId, clientId: a.fx.clientId, productId: a.fx.tenant.productId, appliedAmount: 100_000, appliedTermDays: 31 }
    await expect(db().loanApplication.create({ data: { ...base, reference: `X1-${a.loanId}`, status: "UNDER_REVIEW", loanChangeRequestId: inPlace } })).rejects.toThrow()
    await expect(db().loanApplication.create({ data: { ...base, reference: `X2-${a.loanId}`, status: "UNDER_REVIEW", loanChangeRequestId: "nope" } })).rejects.toThrow()
    const { id } = await draftAndSubmit(b, { type: "REFINANCE", instalments: 12 })
    await expect(db().loanApplication.create({ data: { ...base, reference: `X3-${a.loanId}`, status: "UNDER_REVIEW", loanChangeRequestId: id } })).rejects.toThrow() // another borrower's
    const own = await db().loanApplication.create({ data: { ...base, reference: `X4-${a.loanId}`, status: "DRAFT" } })
    await expect(db().loanApplication.update({ where: { id: own.id }, data: { loanChangeRequestId: id } })).rejects.toThrow()
    const withdrawn = await draftAndSubmit(a, { type: "REFINANCE", instalments: 12 })
    as(a, "maker")
    await actionRoute(req({}), params({ id: withdrawn.id, action: "withdraw" }))
    await expect(db().loanApplication.create({ data: { ...base, clientId: a.fx.clientId, reference: `X5-${a.loanId}`, status: "UNDER_REVIEW", loanChangeRequestId: withdrawn.id } })).rejects.toThrow()
  })

  it("top-up reference: refused with a reason, also differing in case; no 500", async () => {
    const l = await bookLoan(db())
    await db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: "simulated" } })
    await runWithTenant(l.tenantId, () => runScreening({ tenantId: l.tenantId, subject: { clientId: l.fx.clientId }, trigger: "MANUAL", actor: null }))
    await db().loanApplication.update({ where: { id: l.fx.applicationId }, data: { disbursementRef: "EFT-DUP-1" } })
    const a = await draftAndSubmit(l, { type: "TOP_UP", newMoneyCents: 100_000, payoutReference: "eft-dup-1", instalments: 12 })
    log("topup dup", a.submitted.status)
    expect(a.submitted.status).toBe(422)
    const two = await bookLoan(db())
    await db().tenantConfig.update({ where: { tenantId: two.tenantId }, data: { screeningProvider: "simulated" } })
    await runWithTenant(two.tenantId, () => runScreening({ tenantId: two.tenantId, subject: { clientId: two.fx.clientId }, trigger: "MANUAL", actor: null }))
    await db().loanApplication.update({ where: { id: two.fx.applicationId }, data: { disbursementRef: "EFTX1" } })
    const wild = await draftAndSubmit(two, { type: "TOP_UP", newMoneyCents: 100_000, payoutReference: "EFT_1", instalments: 12 })
    log("topup wildcard", wild.submitted.status)
    expect(wild.submitted.status).toBe(200)
  })
})
