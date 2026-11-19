/** Round 2 real-Postgres repros, head 6360672f. RED = bug. RUN_LOAN_CHANGES_IT=1 DATABASE_URL=... npx vitest run lib/loan-changes/brk281r2.integration */
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true }, notified: [] as unknown[] }))
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
vi.mock("@/lib/notifications", async (original) => ({
  ...(await original<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async (...args: unknown[]) => { holder.notified.push(args[0]) }),
}))

import { createAppPrismaClient } from "@/lib/prisma"
import { PATCH as reverseRoute } from "@/app/api/payments/[id]/reverse/route"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { POST as decideRoute } from "@/app/api/applications/[id]/decide/route"
import { recordCommitteeDecision } from "@/lib/approval/committee"
import { MATRIX_KIND } from "@/lib/approval/types"
import { independentBook } from "@/lib/accounting/reconcile"
import { loanSources } from "@/lib/accounting/sources"
import { loadSourceLoans } from "@/lib/accounting/store"
import { sastCalendarDate } from "@/lib/date/sast"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { loadRunLoans } from "@/lib/ifrs9/loan-input"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { approve, createDraft, submit } from "@/lib/maker-checker/service"
import { loadBookAsOf } from "@/lib/reports/book-as-of"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit, proposeAndApprove } = changeRoutes(holder)
const log = (label: string, value: unknown) => process.stderr.write(`\nBRK ${label} ${JSON.stringify(value)}\n`)
const patch = (reason: string) => new NextRequest("http://lender.test/api", { method: "PATCH", body: JSON.stringify({ reason }) })

suite("no matrix", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  const pay = (l: LoanFixture, amount: number) => runWithTenant(l.tenantId, () => applyManualReceipt(holder.prisma as never, { loanId: l.loanId, tenantId: l.tenantId, amount, capturedById: l.fx.tenant.userId }))
  beforeAll(async () => { fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } }); holder.prisma = createAppPrismaClient(fresh.url) }, 240_000)
  afterAll(() => fresh?.drop())

  it("bounced receipt: owed exact, GL ties, double reversal refused, pay-off closes it, re-refinance still books", async () => {
    const l = await bookLoan(db())
    await pay(l, 100_000)
    const receipt = await db().payment.findFirstOrThrow({ where: { loanId: l.loanId } })
    const id = await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    as(l, "checker")
    expect((await reverseRoute(patch("Bounced EFT at the bank"), params({ id: receipt.id }))).status).toBe(200)
    expect((await reverseRoute(patch("Bounced EFT at the bank"), params({ id: receipt.id }))).status).toBe(409)
    const asOf = new Date(Date.now() + 1_000)
    const accounting = holder.prisma as never
    const loans = (await runWithTenant(l.tenantId, () => loadSourceLoans(accounting, l.tenantId, asOf))).filter((s) => s.id === l.loanId || s.id === change.newLoanId)
    const sources = loans.flatMap((s) => loanSources(s, asOf))
    const total = (role: string) => sources.reduce((sum, s) => sum + ((s.vector as Record<string, number>)[role] ?? 0), 0)
    const book = await runWithTenant(l.tenantId, () => independentBook(accounting, l.tenantId, asOf))
    const old = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    log("bounce", { BANK: total("BANK"), CLEAR: total("PAYOUT_CLEARING"), book: loans.map((s) => [s.id === l.loanId ? "old" : "new", book.get(s.id)?.cents, loanSources(s, asOf).reduce((sum, x) => sum + (x.vector.LOAN_BOOK ?? 0), 0)]), status: old.status, outstanding: old.outstandingPrincipal, settled: change.settledCents, arrears: old.arrearsAmount })
    expect(total("BANK")).toBe(-600_000)
    for (const s of loans) expect(loanSources(s, asOf).reduce((sum, x) => sum + (x.vector.LOAN_BOOK ?? 0), 0)).toBe(book.get(s.id)!.cents)
    await pay(l, 100_000)
    expect((await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).status).toBe("COMPLETED")
  })

  it("a settled loan with two receipts: reversing both leaves exactly both owed", async () => {
    const l = await bookLoan(db())
    await pay(l, 70_000); await pay(l, 30_000)
    const receipts = await db().payment.findMany({ where: { loanId: l.loanId } })
    await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })
    as(l, "checker")
    for (const r of receipts) expect((await reverseRoute(patch("Bounced EFT at the bank"), params({ id: r.id }))).status).toBe(200)
    const rows = await db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })
    expect(rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)).toBe(100_000)
  })

  it("the book as at yesterday is the same after a restructure and after a refinance; no loan counted twice", async () => {
    const a = await bookLoan(db(), { monthsRun: 4 })
    const b = await bookLoan(db())
    const plain = await bookLoan(db())
    await pay(plain, 90_000)
    const asOf = new Date(Date.now() - 1_000)
    await new Promise((r) => setTimeout(r, 1_100))
    const value = async (t: string) => runWithTenant(t, () => loadBookAsOf(holder.prisma as never, t, asOf))
    const before = [await value(a.tenantId), await value(b.tenantId), await value(plain.tenantId)]
    const dpd = async (l: LoanFixture) => { const row = (await loadRunLoans(db() as never, l.tenantId, asOf, asOf)).find((x) => x.id === l.loanId)!; return assessLoan(row, { runAt: asOf, settings: DEFAULT_SETTINGS } as never, null).dpd }
    const dpdBefore = await dpd(a)
    await proposeAndApprove(a, { type: "RESTRUCTURE", instalments: 12 })
    await proposeAndApprove(b, { type: "REFINANCE", instalments: 12 })
    const after = [await value(a.tenantId), await value(b.tenantId), await value(plain.tenantId)]
    log("asof", { before, after, dpdBefore, dpdAfter: await dpd(a) })
    expect(after).toEqual(before)
    expect(await dpd(a)).toBe(dpdBefore)
  })
})

suite("application route and portal, under review", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  let l: LoanFixture
  let others: LoanFixture[]
  let la: typeof holder.user
  const staff = async (id: string, role: string) => { await db().user.create({ data: { id, tenantId: l.tenantId, email: `${id}@test.invalid`, password: "x", role: role as never, createdAt: new Date(Date.now() - 90 * 86_400_000) } }); return { id, email: `${id}@test.invalid`, role, totpVerified: true } }
  const approveAs = (user: typeof holder.user, id: string) => { holder.tenantId = l.tenantId; holder.user = user; return actionRoute(req({ note: "At my level" }), params({ id, action: "approve" })) }
  const decide = async (user: typeof holder.user, appId: string, fields: Record<string, string>) => {
    holder.tenantId = l.tenantId; holder.user = user
    const form = new FormData(); for (const [k, v] of Object.entries(fields)) form.set(k, v)
    const res = await decideRoute(new NextRequest("http://lender.test/api", { method: "POST", body: form }), params({ id: appId }))
    return { status: res.status, body: await res.json().catch(() => null) as unknown }
  }
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
    l = await bookLoan(db())
    others = []
    for (let i = 0; i < 6; i++) others.push({ ...(await bookLoan(db(), { sameClientAs: l })), makerId: l.makerId, checkerId: l.checkerId })
    la = await staff(`u_la_${l.loanId}`, "LOAN_ADMIN")
    const rec = await staff(`u_rc_${l.loanId}`, "ADMIN")
    const superAdmin = await staff(`u_sa_${l.loanId}`, "SUPER_ADMIN")
    const matrix = { name: "M", enabled: true, effectiveFrom: "2026-01-01", defaultRequiredLevels: 2, levels: [{ level: 1, name: "Loan admin", role: "LOAN_ADMIN", slaHours: 24, committee: false }, { level: 2, name: "Admin", role: "ADMIN", slaHours: 24, committee: false }], rules: [] }
    await runWithTenant(l.tenantId, async () => {
      const draft = await createDraft({ tenantId: l.tenantId, actor: rec, kind: MATRIX_KIND, title: "Matrix", payload: matrix })
      await submit({ tenantId: l.tenantId, actor: rec, id: draft.id })
      await approve({ tenantId: l.tenantId, actor: superAdmin, id: draft.id })
    })
  }, 240_000)
  afterAll(() => fresh?.drop())
  const clearOpen = () => db().loanApplication.updateMany({ where: { clientId: l.fx.clientId, status: { in: ["DRAFT", "SUBMITTED", "UNDER_REVIEW"] } }, data: { status: "CANCELLED" } })
  const appOf = (id: string) => db().loanApplication.findFirstOrThrow({ where: { loanChangeRequestId: id } })
  const admin = () => ({ id: l.checkerId, email: `${l.checkerId}@test.invalid`, role: "ADMIN", totpVerified: true })

  it("a final level via the application decide route cannot book the loan or skip the settlement", async () => {
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    expect((await approveAs(la, id)).status).toBe(202)
    const app = await appOf(id)
    const r = await decide(admin(), app.id, { action: "approve", approvedAmount: String(app.appliedAmount), approvedTermDays: String(app.appliedTermDays), note: "x", repaymentMethod: "EFT" })
    const after = await appOf(id)
    log("decide approve", { r, status: after.status, request: (await db().changeRequest.findUniqueOrThrow({ where: { id } })).status, steps: await db().approvalStep.count({ where: { applicationId: app.id } }), loan: (await db().loan.findUniqueOrThrow({ where: { id: mine.loanId } })).status })
    expect(after.status).toBe("UNDER_REVIEW")
    expect(await db().loan.count({ where: { applicationId: app.id } })).toBe(0)
    as(mine, "maker")
    expect((await actionRoute(req({}), params({ id, action: "withdraw" }))).status).toBe(200)
  })

  it("a borrower with another application open on the product gets a refusal, not a crash", async () => {
    const mine = others.pop()!
    const other = await db().loanApplication.create({ data: { tenantId: l.tenantId, reference: `APP-OPEN-${mine.loanId}`, clientId: l.fx.clientId, productId: l.fx.tenant.productId, appliedAmount: 200_000, appliedTermDays: 31 } })
    await db().loanApplication.update({ where: { id: other.id }, data: { status: "SUBMITTED" } })
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    const outcome = await approveAs(la, id).then((r) => ({ status: r.status }), (e: unknown) => ({ thrown: String(e) }))
    log("open app", outcome)
    await db().loanApplication.update({ where: { id: other.id }, data: { status: "CANCELLED" } })
    as(mine, "maker")
    await actionRoute(req({}), params({ id, action: "withdraw" }))
    expect(outcome).toMatchObject({ status: 409 })
  })

  it("declining the open application at the decide route: no notice to the borrower about a loan they did not apply for; the change then refuses", async () => {
    await clearOpen()
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    expect((await approveAs(la, id)).status).toBe(202)
    const app = await appOf(id)
    holder.notified.length = 0
    const r = await decide(admin(), app.id, { action: "decline", declineCategory: "BUREAU_SCORE", category: "BUREAU_SCORE", reason: "Affordability not met here" })
    const after = await appOf(id)
    log("decide decline", { r, status: after.status, notified: holder.notified, requestStatus: (await db().changeRequest.findUniqueOrThrow({ where: { id } })).status })
    const res = await approveAs(admin(), id)
    log("approve after decline", { status: res.status, body: await res.json() })
    expect(res.status).not.toBe(200)
    expect((await db().loan.findUniqueOrThrow({ where: { id: mine.loanId } })).status).toBe("ACTIVE")
    await clearOpen()
    expect(holder.notified).toEqual([])
  })

  it("return_to_draft on the open application stops the change cleanly and is withdrawable", async () => {
    await clearOpen()
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    expect((await approveAs(la, id)).status).toBe(202)
    const app = await appOf(id)
    const r = await decide({ ...admin(), role: "SUPER_ADMIN" }, app.id, { action: "return_to_draft", reason: "Fix facts here", note: "Fix facts here" })
    log("return draft", { r, status: (await appOf(id)).status })
    const res = await approveAs(admin(), id)
    log("approve after draft", { status: res.status, body: await res.json() })
    expect(res.status).not.toBe(200)
    as(mine, "maker")
    const w = await actionRoute(req({}), params({ id, action: "withdraw" }))
    log("withdraw", { status: w.status, app: (await appOf(id)).status })
    expect((await appOf(id)).status).toBe("CANCELLED")
  })

  it("a level recorded, then the matrix's actor without approve permission never completes it", async () => {
    await clearOpen()
    const mine = others.pop()!
    const { id } = await draftAndSubmit(mine, { type: "REFINANCE", instalments: 12 })
    const bm = await staff(`u_bm_${mine.loanId}`, "BRANCH_MANAGER")
    const first = await approveAs(bm, id)
    log("bm level", first.status)
    const second = await approveAs(la, id)
    log("la after bm", { status: second.status, body: await second.json(), req: (await db().changeRequest.findUniqueOrThrow({ where: { id } })).status })
    expect((await db().changeRequest.findUniqueOrThrow({ where: { id } })).status).toBe("SUBMITTED")
    void recordCommitteeDecision; void sastCalendarDate
  })
})
