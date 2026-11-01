/**
 * Real-Postgres proof of loan changes (migration 20261101100100_loan_changes): nothing changes a loan until a second person approves, the schedule
 * reconciles to the cent and the old schedule survives, through the real routes on a Lesotho (KEY_FACTS) instance.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/
 *
 * Its own throwaway database (the instance jurisdiction is a property of the whole database): the role needs CREATEDB. Only
 * the session is stood in for: the routes, the service, the guards and the triggers are the real ones.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
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

import { createAppPrismaClient } from "@/lib/prisma"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { GET as changesRoute } from "@/app/api/loans/[id]/changes/route"
import { POST as previewRoute } from "@/app/api/loans/[id]/changes/preview/route"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { bookLoan, changeRoutes, type LoanFixture, type LoanOptions } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit, proposeAndApprove } = changeRoutes(holder)

suite("loan changes in place, on a Lesotho instance (real Postgres, real routes)", () => {
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

  it("nothing changes until a different person approves; approval rewrites the unpaid rows and keeps the history", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
    const before = await rowsOf(l.loanId)
    const { id, submitted } = await draftAndSubmit(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    expect(submitted.status).toBe(200)

    expect(await rowsOf(l.loanId)).toEqual(before)
    expect((await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).interestRatePm).toBe(0.04)

    as(l, "maker") // the maker holds no approval permission, and no role would let them approve their own
    expect((await actionRoute(req({}), params({ id, action: "approve" }))).status).toBe(403)
    holder.user = { ...holder.user, role: "SUPER_ADMIN" }
    expect(await (await actionRoute(req({}), params({ id, action: "approve" }))).json()).toMatchObject({ code: "SELF_APPROVAL" })
    expect(await rowsOf(l.loanId)).toEqual(before)

    as(l, "checker")
    expect((await actionRoute(req({ note: "Seen the paper" }), params({ id, action: "approve" }))).status).toBe(200)

    const { row, rows } = await reconciled(l.loanId)
    expect(row.interestRatePm).toBe(0.03)
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(before.slice(0, 3).map((r) => r.id))
    expect(rows).toHaveLength(6)
    expect(rows.slice(3).every((r) => !before.some((b) => b.id === r.id))).toBe(true)
    expect(rows.slice(3).map((r) => r.dueDate)).toEqual(before.slice(3).map((r) => r.dueDate))
    expect(row.restructuredAt).toBeNull()

    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    expect(change).toMatchObject({ type: "RATE_CHANGE", makerId: l.makerId, checkerId: l.checkerId, markedRestructured: false })
    const replaced = (change.scheduleBefore as Array<{ rows: Array<{ id: string; totalDue: number }> }>)[0]!.rows
    expect(replaced.map((r) => [r.id, r.totalDue])).toEqual(before.map((r) => [r.id, r.totalDue]))

    const terms = await db().loanTerms.findMany({ where: { loanId: l.loanId }, orderBy: { sequence: "asc" } })
    expect(terms.map((t) => [t.sequence, t.interestRatePm, t.changeRequestId])).toEqual([[1, 0.04, id], [2, 0.03, id]])
    expect(await db().auditLog.count({ where: { tenantId: l.tenantId, action: "LOAN_CHANGE_APPLIED", entityId: l.loanId } })).toBe(1)
    expect(await db().auditLog.count({ where: { tenantId: l.tenantId, action: "CHANGE_REQUEST_APPROVED", entityId: id } })).toBe(1)
  })

  it("a payment holiday and a term change append terms in sequence and show on the loan's history route", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
    await proposeAndApprove(l, { type: "PAYMENT_HOLIDAY", holidayInstalments: 2 })
    await proposeAndApprove(l, { type: "TERM_CHANGE", instalments: 9 })
    const { row, rows } = await reconciled(l.loanId)
    expect(rows.filter((r) => r.totalPaid === 0)).toHaveLength(9)
    expect(row.restructuredAt).not.toBeNull()
    as(l, "maker")
    const view = await (await changesRoute(req(), params({ id: l.loanId }))).json() as { applied: Array<{ type: string }>; terms: Array<{ sequence: number; graceKind: string | null }>; requests: unknown[] }
    expect(view.applied.map((c) => c.type)).toEqual(["TERM_CHANGE", "PAYMENT_HOLIDAY"])
    expect(view.terms.map((t) => [t.sequence, t.graceKind])).toEqual([[1, null], [2, "FULL"], [3, "NONE"]])
    expect(view.requests).toHaveLength(2)
    // A read-only user sees what happened to the loan, not the proposals or the borrower's document names.
    holder.user = { ...holder.user, role: "READONLY" }
    const readonly = await (await changesRoute(req(), params({ id: l.loanId }))).json() as { applied: unknown[]; requests: unknown[]; documents: unknown[]; canPropose: boolean }
    expect(readonly).toMatchObject({ canPropose: false, requests: [], documents: [] })
    expect(readonly.applied).toHaveLength(2)
  })

  it("a restructure cures a defaulted loan's arrears, carries what fell due and records the status change", async () => {
    const l = await loan({ status: "DEFAULTED" })
    const before = await rowsOf(l.loanId)
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12, interestRatePm: 0.02 })
    const { row, rows } = await reconciled(l.loanId)
    expect(row).toMatchObject({ status: "ACTIVE", arrearsAmount: 0, daysInArrears: 0, outstandingPrincipal: 600_000 })
    expect(rows).toHaveLength(12)
    expect(row.nextPaymentDate!.getTime()).toBeGreaterThan(Date.now())
    const carried = before.slice(0, 3).reduce((sum, r) => sum + r.interestDue, 0)
    expect(rows.reduce((sum, r) => sum + r.interestDue, 0)).toBeGreaterThan(carried)
    const status = await db().auditLog.findFirstOrThrow({ where: { tenantId: l.tenantId, action: "LOAN_STATUS_CHANGED", entityId: l.loanId } })
    expect(status.newValue).toMatchObject({ status: "ACTIVE", reason: "loan_change" })
  })

  it("a second change does not lose what the first carried", async () => {
    const l = await loan() // three instalments overdue
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12 })
    const { row: first } = await reconciled(l.loanId)
    await proposeAndApprove(l, { type: "TERM_CHANGE", instalments: 12 })
    const { row: second, rows } = await reconciled(l.loanId)
    expect(second.totalRepayable).toBe(first.totalRepayable)
    expect(rows.reduce((sum, r) => sum + r.carriedInterestDue + r.carriedFeesDue, 0)).toBeGreaterThan(0)
  })

  it("a part-paid row stays as what was paid and every receipt still adds up", async () => {
    const l = await loan()
    const first = await dueRowsTotal(l.loanId, 1)
    await pay(l, first + 12_345)
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 8 })
    const { rows } = await reconciled(l.loanId)
    expect(rows[1]).toMatchObject({ totalDue: 12_345, totalPaid: 12_345, status: "PAID" })
    expect(rows.filter((r) => r.totalPaid === 0)).toHaveLength(8)
  })

  it("a receipt after submission is honoured: the approval computes on the balance of that moment", async () => {
    const l = await loan()
    const { id, submitted } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 4 })
    expect(submitted.status).toBe(200)
    await pay(l, await dueRowsTotal(l.loanId, 2))
    as(l, "checker")
    expect((await actionRoute(req({}), params({ id, action: "approve" }))).status).toBe(200)
    const { rows } = await reconciled(l.loanId)
    expect(rows.filter((r) => r.totalPaid > 0)).toHaveLength(2)
    expect(rows).toHaveLength(6)
  })

  it("a rejected change leaves the loan alone, and stays on its history with the reason", async () => {
    const l = await loan()
    const before = await rowsOf(l.loanId)
    const { id } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 4 })
    as(l, "checker")
    expect((await actionRoute(req({ note: "Affordability does not support it" }), params({ id, action: "reject" }))).status).toBe(200)
    expect(await rowsOf(l.loanId)).toEqual(before)
    expect(await db().loanChange.count({ where: { loanId: l.loanId } })).toBe(0)
    const view = await (await changesRoute(req(), params({ id: l.loanId }))).json() as { requests: Array<{ status: string; decisionNote: string | null; checker: string | null }> }
    expect(view.requests).toEqual([expect.objectContaining({ status: "REJECTED", decisionNote: "Affordability does not support it", checker: `${l.checkerId}@test.invalid` })])
  })

  it("a change drafted before another was applied is stale, and leaves the loan alone", async () => {
    const l = await loan()
    const { id } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 4 })
    await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    as(l, "checker")
    const stale = await actionRoute(req({}), params({ id, action: "approve" }))
    expect(stale.status).toBe(409)
    expect(await db().loanChange.count({ where: { loanId: l.loanId } })).toBe(1)
  })

  it("the preview shows the rows without writing, and answers a refusal as a reason", async () => {
    const l = await loan()
    const before = await rowsOf(l.loanId)
    as(l, "maker")
    const preview = await (await previewRoute(req({ type: "RESTRUCTURE", instalments: 10, reason: "Income fell", signedDocumentId: l.documentId }), params({ id: l.loanId }))).json() as { rows: unknown[]; refusal: string | null }
    expect(preview.refusal).toBeNull()
    expect(preview.rows).toHaveLength(10)
    expect(await rowsOf(l.loanId)).toEqual(before)
    const refused = await (await previewRoute(req({ type: "REFINANCE", instalments: 10, reason: "Income fell", signedDocumentId: "not-a-document" }), params({ id: l.loanId }))).json() as { refusal: string | null }
    expect(refused.refusal).toMatch(/signed document/)
    holder.user = { ...holder.user, role: "CREDIT_OFFICER" }
    expect((await previewRoute(req({ type: "RESTRUCTURE", instalments: 10, reason: "Income fell", signedDocumentId: l.documentId }), params({ id: l.loanId }))).status).toBe(403)
  })
})
