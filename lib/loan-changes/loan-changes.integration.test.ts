/**
 * Real-Postgres proof of loan changes (migration 20261101100100_loan_changes), through the real routes on a Lesotho
 * (KEY_FACTS) instance and, for the refusals, a South African one: nothing changes a loan until a second person approves,
 * the schedule reconciles to the cent, the old schedule survives, settlement runs through the receipt path, the ledger moves
 * only new money, IFRS 9 sees the restructure, and the database holds the rules whatever the code does.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/loan-changes.integration.test.ts
 *
 * Each suite has its own throwaway database (the instance jurisdiction is a property of the whole database). The role needs
 * CREATEDB. Only the session is stood in for: the routes, the service, the guards and the triggers are the real ones.
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
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
import { POST as draftRoute } from "@/app/api/maker-checker/route"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { PATCH as reverseRoute } from "@/app/api/payments/[id]/reverse/route"
import { GET as changesRoute } from "@/app/api/loans/[id]/changes/route"
import { POST as previewRoute } from "@/app/api/loans/[id]/changes/preview/route"
import { independentBook } from "@/lib/accounting/reconcile"
import { loanSources } from "@/lib/accounting/sources"
import { loadSourceLoans } from "@/lib/accounting/store"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { inheritPriorStaging, loadRunLoans } from "@/lib/ifrs9/loan-input"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { bookLoan, type LoanFixture, type LoanOptions } from "./loan-changes.integration-fixture"
import { LOAN_CHANGE_KIND } from "./types"
import { NCA_REFUSAL } from "./eligibility"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const req = (body?: unknown) => new NextRequest("http://lender.test/api", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
const params = <T,>(value: T) => ({ params: Promise.resolve(value) })

function as(l: LoanFixture, who: "maker" | "checker") {
  holder.tenantId = l.tenantId
  const id = who === "maker" ? l.makerId : l.checkerId
  holder.user = { id, email: `${id}@test.invalid`, role: who === "maker" ? "LOAN_ADMIN" : "ADMIN", totpVerified: true }
}

async function draftAndSubmit(l: LoanFixture, payload: Record<string, unknown>) {
  as(l, "maker")
  const body = { kind: LOAN_CHANGE_KIND, title: `Change ${payload.type as string}`, payload: { loanId: l.loanId, reason: "Borrower asked; income fell", signedDocumentId: l.documentId, ...payload } }
  const drafted = await draftRoute(req(body))
  expect(drafted.status).toBe(201)
  const id = ((await drafted.json()) as { request: { id: string } }).request.id
  const submitted = await actionRoute(req({}), params({ id, action: "submit" }))
  return { id, submitted }
}

async function proposeAndApprove(l: LoanFixture, payload: Record<string, unknown>) {
  const { id, submitted } = await draftAndSubmit(l, payload)
  expect(submitted.status).toBe(200)
  as(l, "checker")
  const approved = await actionRoute(req({ note: "Seen the paper" }), params({ id, action: "approve" }))
  expect(approved.status).toBe(200)
  return id
}

suite("loan changes on a Lesotho instance (real Postgres, real routes)", () => {
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

  it("a top-up pays out only the new money: the ledger's bank moves by it, both books tie", async () => {
    const l = await loan()
    await pay(l, await dueRowsTotal(l.loanId, 3))
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

  describe("the database holds the rules", () => {
    let l: LoanFixture
    let approved: string

    beforeAll(async () => {
      l = await loan()
      approved = await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    })

    const change = (over: Record<string, unknown>) => ({
      tenantId: l.tenantId, loanId: l.loanId, type: "RATE_CHANGE" as const, changeRequestId: randomUUID(), makerId: l.makerId, checkerId: l.checkerId, reason: "A direct write", signedDocumentId: l.documentId,
      before: {}, after: {}, scheduleBefore: [], scheduleAfter: [], ...over,
    })

    it("refuses a change no approved request made, and a second row for one request", async () => {
      await expect(db().loanChange.create({ data: change({}) })).rejects.toThrow(/only by an approved/)
      await expect(db().loanChange.create({ data: change({ changeRequestId: approved }) })).rejects.toThrow(/Unique|changeRequestId/)
    })

    it("an applied change never changes or goes away, and neither do its terms", async () => {
      const row = await db().loanChange.findFirstOrThrow({ where: { changeRequestId: approved } })
      await expect(db().loanChange.update({ where: { id: row.id }, data: { reason: "Rewritten" } })).rejects.toThrow(/never changes/)
      await expect(db().loanChange.delete({ where: { id: row.id } })).rejects.toThrow(/never changes/)
      await expect(db().$executeRawUnsafe(`TRUNCATE "LoanChange"`)).rejects.toThrow(/never changes/)
      await expect(db().loanTerms.deleteMany({ where: { loanId: l.loanId } })).rejects.toThrow(/never change/)
    })

    it("refuses later terms with no approved request", async () => {
      const next = (await db().loanTerms.count({ where: { loanId: l.loanId } })) + 1
      await expect(db().loanTerms.create({ data: { tenantId: l.tenantId, loanId: l.loanId, sequence: next, baseRatePm: 0.01, interestRatePm: 0.01, changeRequestId: "made-up" } })).rejects.toThrow(/approved LOAN_CHANGE/)
    })

    it("refuses an application claiming a request, and a request added to one later", async () => {
      await expect(db().loanApplication.create({
        data: { tenantId: l.tenantId, reference: `APP-${randomUUID()}`, clientId: l.fx.clientId, productId: l.fx.tenant.productId, appliedAmount: 100_000, appliedTermDays: 31, loanChangeRequestId: approved },
      })).rejects.toThrow(/approved top-up/)
      await expect(db().loanApplication.update({ where: { id: l.fx.applicationId }, data: { loanChangeRequestId: approved } })).rejects.toThrow(/never changes/)
    })

    it("refuses a settlement receipt no change made, and a reversal of a real one", async () => {
      await expect(db().payment.create({ data: { tenantId: l.tenantId, loanId: l.loanId, amount: 100, paymentMethod: "LOAN_SETTLEMENT" } })).rejects.toThrow(/approved change settled/)
      const r = await loan()
      await proposeAndApprove(r, { type: "REFINANCE", instalments: 12 })
      const receipt = await db().payment.findFirstOrThrow({ where: { loanId: r.loanId, paymentMethod: "LOAN_SETTLEMENT" } })
      await expect(db().payment.update({ where: { id: receipt.id }, data: { reversed: true } })).rejects.toThrow(/never reversed/)
    })

    it("refuses to commit a change whose schedule does not reconcile to the cent", async () => {
      const r = await loan()
      const request = await db().changeRequest.create({ data: { tenantId: r.tenantId, kind: LOAN_CHANGE_KIND, title: "Direct", payload: { type: "RATE_CHANGE", loanId: r.loanId, reason: "Direct", signedDocumentId: r.documentId, interestRatePm: 0.01 }, makerId: r.makerId } })
      await db().changeRequest.update({ where: { id: request.id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
      await db().changeRequest.update({ where: { id: request.id }, data: { status: "APPROVED", checkerId: r.checkerId, decidedAt: new Date(), appliedAt: new Date() } })
      const write = (cents: number) => db().$transaction(async (tx) => {
        await tx.repaymentSchedule.updateMany({ where: { loanId: r.loanId, installmentNo: 6 }, data: { principalDue: { increment: cents }, totalDue: { increment: cents } } })
        await tx.loanChange.create({ data: change({ loanId: r.loanId, changeRequestId: request.id, makerId: r.makerId, checkerId: r.checkerId, signedDocumentId: r.documentId, tenantId: r.tenantId }) })
        await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
      })
      await expect(write(1)).rejects.toThrow(/to the cent/)
      await write(0)
      expect(await db().loanChange.count({ where: { changeRequestId: request.id } })).toBe(1)
    })
  })
})

suite("loan changes on a South African instance (real Postgres, real routes)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => {
    fresh = await createThrowawayDb()
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("refuses every type of change on an NCA loan, and the database refuses it too", async () => {
    const tenant = await createChargesTenant(db(), false)
    const created = await createChargesLoan(db(), tenant)
    const ncaLoan = await db().loan.findFirstOrThrow({ where: { tenantId: tenant.tenantId } })
    expect(created).toBeTruthy()
    const document = await db().clientDocument.create({
      data: { tenantId: tenant.tenantId, clientId: ncaLoan.clientId!, docType: "OTHER", fileName: "x.pdf", fileUrl: "", storagePath: "/synthetic/x.pdf", fileSize: 1, mimeType: "application/pdf", uploadedByType: "staff", extractionStatus: "skipped", verified: false },
    })
    const old = new Date(Date.now() - 90 * 86_400_000)
    const makerId = `u_m_${tenant.tenantId}`
    const checkerId = `u_c_${tenant.tenantId}`
    await db().user.create({ data: { id: makerId, tenantId: tenant.tenantId, email: `${makerId}@test.invalid`, password: "x", role: "LOAN_ADMIN", createdAt: old } })
    await db().user.create({ data: { id: checkerId, tenantId: tenant.tenantId, email: `${checkerId}@test.invalid`, password: "x", role: "ADMIN", createdAt: old } })
    const l = { fx: { clientId: ncaLoan.clientId!, tenant }, loanId: ncaLoan.id, documentId: document.id, makerId, checkerId, tenantId: tenant.tenantId } as unknown as LoanFixture

    const scheduleBefore = await db().repaymentSchedule.findMany({ where: { loanId: ncaLoan.id } })
    const cases = [
      { type: "RESCHEDULE", firstDueDate: "2099-01-01" }, { type: "RESTRUCTURE", instalments: 12 }, { type: "PAYMENT_HOLIDAY", holidayInstalments: 1 },
      { type: "RATE_CHANGE", interestRatePm: 0.01 }, { type: "TERM_CHANGE", instalments: 12 },
      { type: "TOP_UP", newMoneyCents: 100, payoutReference: "EFT-1", instalments: 12 }, { type: "REFINANCE", instalments: 12 }, { type: "CONSOLIDATION", otherLoanIds: ["other"], instalments: 12 },
    ]
    for (const payload of cases) {
      const { submitted } = await draftAndSubmit(l, payload)
      expect(submitted.status).toBe(422)
      expect(((await submitted.json()) as { error: string }).error).toContain(NCA_REFUSAL)
    }
    expect(await db().repaymentSchedule.findMany({ where: { loanId: ncaLoan.id } })).toEqual(scheduleBefore)

    // Even an approved request cannot write one: only the service refuses it above, and the trigger refuses it here.
    const request = await db().changeRequest.create({ data: { tenantId: tenant.tenantId, kind: LOAN_CHANGE_KIND, title: "Direct", payload: { type: "RATE_CHANGE", loanId: ncaLoan.id, reason: "Direct", signedDocumentId: document.id, interestRatePm: 0.01 }, makerId } })
    await db().changeRequest.update({ where: { id: request.id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
    await db().changeRequest.update({ where: { id: request.id }, data: { status: "APPROVED", checkerId, decidedAt: new Date(), appliedAt: new Date() } })
    await expect(db().loanChange.create({
      data: { tenantId: tenant.tenantId, loanId: ncaLoan.id, type: "RATE_CHANGE", changeRequestId: request.id, makerId, checkerId, reason: "Direct write", signedDocumentId: document.id, before: {}, after: {}, scheduleBefore: [], scheduleAfter: [] },
    })).rejects.toThrow(/NCA/)
  })
})
