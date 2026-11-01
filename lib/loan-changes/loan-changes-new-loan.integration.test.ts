/**
 * Real-Postgres proof of loan changes (migration 20261101100100_loan_changes): a top-up, refinance or consolidation settles through the receipt path and
 * books a new loan; the ledger moves only new money; IFRS 9 sees the restructure and a replacement loan does not cure a stage.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/
 *
 * Its own throwaway database (the instance jurisdiction is a property of the whole database): the role needs CREATEDB. Only
 * the session is stood in for: the routes, the service, the guards and the triggers are the real ones.
 */
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runScreening } from "@/lib/screening/run"
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

import { createAppPrismaClient } from "@/lib/prisma"
import { PATCH as reverseRoute } from "@/app/api/payments/[id]/reverse/route"
import { POST as previewRoute } from "@/app/api/loans/[id]/changes/preview/route"
import { independentBook } from "@/lib/accounting/reconcile"
import { loanSources } from "@/lib/accounting/sources"
import { loadSourceLoans } from "@/lib/accounting/store"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { inheritPriorStaging, loadRunLoans } from "@/lib/ifrs9/loan-input"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { sastCalendarDate } from "@/lib/date/sast"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { bookLoan, changeRoutes, type LoanFixture, type LoanOptions } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit, proposeAndApprove } = changeRoutes(holder)

suite("loan changes that book a new loan, on a Lesotho instance (real Postgres, real routes)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  const loan = (opts?: LoanOptions) => bookLoan(db(), opts)
  const rowsOf = (id: string) => db().repaymentSchedule.findMany({ where: { loanId: id }, orderBy: [{ installmentNo: "asc" }] })
  const pay = (l: LoanFixture, amount: number) => runWithTenant(l.tenantId, () => applyManualReceipt(holder.prisma as never, { loanId: l.loanId, tenantId: l.tenantId, amount, capturedById: l.fx.tenant.userId }))
  const dueRowsTotal = async (id: string, count: number) => (await rowsOf(id)).slice(0, count).reduce((sum, row) => sum + row.totalDue, 0)

  async function reconciled(id: string) {
    const [row, rows] = await Promise.all([db().loan.findUniqueOrThrow({ where: { id } }), rowsOf(id)])
    expect(rows.reduce((sum, r) => sum + r.principalDue, 0)).toBe(row.principal)
    expect(rows.reduce((sum, r) => sum + r.interestDue, 0)).toBe(row.totalInterest)
    expect(rows.reduce((sum, r) => sum + r.totalDue, 0)).toBe(row.totalRepayable)
    expect(rows.reduce((sum, r) => sum + r.totalPaid, 0)).toBe(row.totalPaid)
    for (const r of rows) expect(r.totalDue).toBe(r.principalDue + r.interestDue + r.feesDue)
    return { row, rows }
  }

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("a refinance settles the old loan through the receipt path and books a new one on its settlement figure", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
    as(l, "maker")
    const preview = await (await previewRoute(req({ type: "REFINANCE", instalments: 12, reason: "Income fell", signedDocumentId: l.documentId }), params({ id: l.loanId }))).json() as { settledCents: number; principal: number }
    expect(preview.settledCents).toBeGreaterThan(0)
    const id = await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })

    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    const old = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    expect(old.status).toBe("COMPLETED")
    expect(old.outstandingPrincipal).toBe(0)
    const receipt = await db().payment.findFirstOrThrow({ where: { loanId: l.loanId, paymentMethod: "LOAN_SETTLEMENT" } })
    expect(receipt.amount).toBe(change.settledCents)
    expect(change.settledCents).toBe(preview.settledCents)
    expect(change.sourceLoanIds).toEqual([l.loanId])

    const { row, rows } = await reconciled(change.newLoanId!)
    expect(row).toMatchObject({ principal: change.settledCents, status: "ACTIVE", clientId: l.fx.clientId, agreementDocId: l.documentId, initiationFee: 0 })
    expect(rows).toHaveLength(12)
    const application = await db().loanApplication.findUniqueOrThrow({ where: { id: row.applicationId } })
    expect(application).toMatchObject({ status: "DISBURSED", disclosureRegime: "KEY_FACTS", loanChangeRequestId: id, approvedById: l.checkerId, disbursedById: l.makerId })
    const terms = await db().loanTerms.findMany({ where: { loanId: row.id } })
    expect(terms.map((t) => [t.sequence, t.changeRequestId])).toEqual([[1, id]])
    expect(await db().auditLog.count({ where: { tenantId: l.tenantId, action: "PAYMENT_RECORDED", entityId: l.loanId, newValue: { path: ["method"], equals: "LOAN_SETTLEMENT" } } })).toBe(1)

    as(l, "checker")
    const reversal = await reverseRoute(new NextRequest("http://lender.test/api", { method: "PATCH", body: JSON.stringify({ reason: "Trying to undo the settlement" }) }), params({ id: receipt.id }))
    expect(reversal.status).toBe(409)
  })

  it("new money needs a screened borrower: no provider, or a borrower never screened, refuses a top-up", async () => {
    const l = await loan()
    const topUp = { type: "TOP_UP", newMoneyCents: 150_000, payoutReference: "EFT-SYN-1", instalments: 10 }
    const unconfigured = (await draftAndSubmit(l, topUp)).submitted
    expect(unconfigured.status).toBe(422)
    expect(((await unconfigured.json()) as { error: string }).error).toMatch(/no screening provider/)
    await db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: "simulated" } })
    expect((await draftAndSubmit(l, topUp)).submitted.status).toBe(422)
  })

  it("a top-up pays out only the new money: the ledger's bank moves by it, both books tie", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
    await db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: "simulated" } })
    await runWithTenant(l.tenantId, () => runScreening({ tenantId: l.tenantId, subject: { clientId: l.fx.clientId }, trigger: "MANUAL", actor: null }))
    const id = await proposeAndApprove(l, { type: "TOP_UP", newMoneyCents: 150_000, payoutReference: "EFT-SYN-1", instalments: 10 })
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    const newLoanId = change.newLoanId!
    const { row } = await reconciled(newLoanId)
    expect(row.principal).toBe(change.settledCents + 150_000)
    expect(change.newMoneyCents).toBe(150_000)
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: row.applicationId } })).disbursementRef).toBe("EFT-SYN-1")

    const asOf = new Date(Date.now() + 1_000)
    const accounting = holder.prisma as never
    const loans = (await runWithTenant(l.tenantId, () => loadSourceLoans(accounting, l.tenantId, asOf))).filter((s) => s.id === l.loanId || s.id === newLoanId)
    const sources = loans.flatMap((s) => loanSources(s, asOf))
    const total = (role: "BANK" | "PAYOUT_CLEARING") => sources.reduce((sum, s) => sum + (s.vector[role] ?? 0), 0)
    const cashIn = await db().payment.aggregate({ where: { loanId: l.loanId, paymentMethod: "EFT" }, _sum: { amount: true } })
    expect(total("BANK")).toBe((cashIn._sum.amount ?? 0) - 600_000 - 150_000)
    expect(total("PAYOUT_CLEARING")).toBe(0)
    for (const s of sources) expect(Object.values(s.vector).reduce((sum, cents) => sum + (cents ?? 0), 0)).toBe(0)
    const book = await runWithTenant(l.tenantId, () => independentBook(accounting, l.tenantId, asOf))
    for (const s of loans) {
      const journal = loanSources(s, asOf).reduce((sum, source) => sum + (source.vector.LOAN_BOOK ?? 0), 0)
      expect(journal).toBe(book.get(s.id)!.cents)
    }
  })

  it("a transfer reference pays one loan: a second top-up on it is refused with the reason", async () => {
    const l = await loan()
    await db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: "simulated" } })
    await runWithTenant(l.tenantId, () => runScreening({ tenantId: l.tenantId, subject: { clientId: l.fx.clientId }, trigger: "MANUAL", actor: null }))
    await proposeAndApprove(l, { type: "TOP_UP", newMoneyCents: 100, payoutReference: "EFT-SYN-ONCE", instalments: 10 })
    const again = await loan({ sameLenderAs: l })
    await runWithTenant(l.tenantId, () => runScreening({ tenantId: l.tenantId, subject: { clientId: again.fx.clientId }, trigger: "MANUAL", actor: null }))
    const { submitted } = await draftAndSubmit(again, { type: "TOP_UP", newMoneyCents: 100, payoutReference: "eft-syn-once", instalments: 10 })
    expect(submitted.status).toBe(422)
    expect(((await submitted.json()) as { error: string }).error).toMatch(/already paid out/)
  })

  it("a consolidation settles every loan of the borrower into one", async () => {
    const a = await loan()
    const b = await loan({ sameClientAs: a, principal: 300_000, instalments: 4 })
    const id = await proposeAndApprove(a, { type: "CONSOLIDATION", otherLoanIds: [b.loanId], instalments: 18 })
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    expect([...change.sourceLoanIds].sort()).toEqual([a.loanId, b.loanId].sort())
    for (const loanId of [a.loanId, b.loanId]) expect((await db().loan.findUniqueOrThrow({ where: { id: loanId } })).status).toBe("COMPLETED")
    const { row } = await reconciled(change.newLoanId!)
    expect(row.principal).toBe(change.settledCents)
    expect(await db().payment.count({ where: { loanId: { in: [a.loanId, b.loanId] }, paymentMethod: "LOAN_SETTLEMENT" } })).toBe(2)
    // Both had instalments overdue, so the new loan is a forbearance.
    expect(row.restructuredAt).not.toBeNull()
  })

  it("refuses another borrower's loan, and another borrower's document, at submission", async () => {
    const a = await loan()
    const other = await loan({ sameClientAs: undefined })
    const { submitted } = await draftAndSubmit(a, { type: "CONSOLIDATION", otherLoanIds: [other.loanId], instalments: 18 })
    expect(submitted.status).toBe(422)
    expect(((await submitted.json()) as { error: string }).error).toMatch(/does not exist|one borrower/)
    const stranger = await loan()
    const { submitted: wrongPaper } = await draftAndSubmit(a, { type: "RATE_CHANGE", interestRatePm: 0.03, signedDocumentId: stranger.documentId })
    expect(wrongPaper.status).toBe(422)
  })

  it("IFRS 9 stages a restructure at least Stage 2, then lets it cure", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
    await proposeAndApprove(l, { type: "PAYMENT_HOLIDAY", holidayInstalments: 1 })
    const runAt = new Date()
    const ctx = { settings: DEFAULT_SETTINGS, parameters: [], runAt, chargesLive: false }
    const run = async () => (await runWithTenant(l.tenantId, () => loadRunLoans(holder.prisma as never, l.tenantId, runAt, null))).find((r) => r.id === l.loanId)!
    const staged = assessLoan(await run(), ctx, null).staging
    expect(staged).toMatchObject({ stage: 2, restructured: true })
    expect(staged.reasons).toContain("RESTRUCTURED")
    // The next month the loan is formerly restructured: its triggers clear and it serves the probation in Stage 2.
    const nextMonth = new Date(runAt.getTime() + 40 * 86_400_000)
    const cured = assessLoan(await run(), { ...ctx, runAt: nextMonth }, { stage: 2, stageSince: "2020-01-01", cureStartedOn: null, restructured: true, runDate: new Date(nextMonth.getTime() - 40 * 86_400_000 + 86_400_000).toISOString().slice(0, 10) }).staging
    expect(cured).toMatchObject({ stage: 2, inProbation: true, restructured: true })
    expect(cured.reasons).toContain("RESTRUCTURE_PROBATION")
  })

  it("IFRS 9: the loan a refinance books starts from the stage of the loan it replaced", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
    const id = await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    const priors = new Map([[l.loanId, { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: null, restructured: false, runDate: "2026-01-31" }]])
    await runWithTenant(l.tenantId, () => inheritPriorStaging(holder.prisma as never, l.tenantId, priors))
    expect(priors.get(change.newLoanId!)?.stage).toBe(3)
  })

  it("IFRS 9: a loan refinanced twice before the next run still starts from the first one's stage, the worst of its sources", async () => {
    const a = await loan({ status: "DEFAULTED" })
    const first = await proposeAndApprove(a, { type: "REFINANCE", instalments: 12 })
    const b = (await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: first } })).newLoanId!
    const second = await proposeAndApprove({ ...a, loanId: b }, { type: "REFINANCE", instalments: 12 })
    const c = (await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: second } })).newLoanId!
    const priors = new Map([[a.loanId, { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: null, restructured: false, runDate: "2026-01-31" }]])
    await runWithTenant(a.tenantId, () => inheritPriorStaging(holder.prisma as never, a.tenantId, priors))
    expect(priors.get(c)?.stage).toBe(3)
  })

  it("IFRS 9: a late run for the day before a restructure sees that day's arrears, and a prior Stage 3 holds through its cure", async () => {
    const l = await loan({ monthsRun: 4, status: "DEFAULTED" })
    const asOf = new Date(Date.now() - 86_400_000)
    const ctx = { settings: DEFAULT_SETTINGS, parameters: [], runAt: asOf, chargesLive: false }
    const load = async () => (await runWithTenant(l.tenantId, () => loadRunLoans(holder.prisma as never, l.tenantId, asOf, asOf))).find((r) => r.id === l.loanId)!
    const before = assessLoan(await load(), ctx, null)
    expect(before.dpd).toBeGreaterThan(90)
    const rows = await rowsOf(l.loanId)
    await proposeAndApprove(l, { type: "RESCHEDULE", firstDueDate: sastCalendarDate(rows[4]!.dueDate) })
    const after = await load()
    expect(after.status).toBe("DEFAULTED")
    expect(assessLoan(after, ctx, null)).toMatchObject({ dpd: before.dpd, staging: { stage: 3 } })
    // Today the arrears are gone, but a Stage 3 loan cures by its clock, not by being restructured.
    const runAt = new Date()
    const today = (await runWithTenant(l.tenantId, () => loadRunLoans(holder.prisma as never, l.tenantId, runAt, null))).find((r) => r.id === l.loanId)!
    const prior = { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: null, restructured: false, runDate: "2026-01-31" }
    expect(today.defaultedAtRestructure).toBe(true)
    expect(assessLoan(today, { ...ctx, runAt }, { ...prior, stage: 2 }).staging).toMatchObject({ stage: 3, restructured: true })
  })
})
