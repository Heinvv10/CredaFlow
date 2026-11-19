/**
 * Breaker repros for PR #281 (lib/loan-changes), head 4bb24c42. Each test ASSERTS THE CORRECT BEHAVIOUR: red = the bug.
 * Copy to lib/loan-changes/ and run: RUN_LOAN_CHANGES_IT=1 DATABASE_URL=... npx vitest run lib/loan-changes/brk281 --testTimeout=120000
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { runScreening } from "@/lib/screening/run"

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

import { NextRequest } from "next/server"
import { createAppPrismaClient } from "@/lib/prisma"
import { PATCH as reverseRoute } from "@/app/api/payments/[id]/reverse/route"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { assessLoan } from "@/lib/ifrs9/snapshot"
import { inheritPriorStaging, loadRunLoans } from "@/lib/ifrs9/loan-input"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { addCalendarMonths } from "@/lib/product-engine/periods"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"
import { planInPlace, type PlanRow } from "./plan"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit, proposeAndApprove } = changeRoutes(holder)

const NOW = new Date("2026-06-15T10:00:00Z")
const rowsOf = (input: Parameters<typeof generateSchedule>[0]): PlanRow[] =>
  generateSchedule(input).schedule.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: 0, paidAt: null }))
const sum = (rows: Array<{ interestDue: number }>) => rows.reduce((s, r) => s + r.interestDue, 0)

describe("money, pure (real plan.ts and generateSchedule)", () => {
  it("a BULLET reschedule by ONE month charges one month more interest, not the whole term again", () => {
    const startDate = new Date("2026-06-01T10:00:00Z")
    const P = 1_000_000
    const terms = { frequency: "MONTHLY", structure: "BULLET", graceKind: "NONE", graceInstalments: 0, instalments: 6 } as const
    const rows = rowsOf({ principalCents: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate, terms })
    expect(sum(rows)).toBe(240_000) // 6 months at 4%
    const plan = planInPlace({ loan: { principal: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0, startDate }, rows, frequency: "MONTHLY", structure: "BULLET", change: { type: "RESCHEDULE", firstDueDate: "2027-01-01" }, asOf: NOW })
    // 7 months at 4% = 280,000 (a day or two of simple interest either way).
    expect(plan.totalInterest).toBeLessThan(285_000)
  })

  it("a change before the first instalment keeps the DEFERRED initiation fee (loan-calculator puts it on row 1)", () => {
    const startDate = new Date("2026-06-10T10:00:00Z")
    const P = 600_000
    const fee = 60_000
    const terms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 6 } as const
    const rows = rowsOf({ principalCents: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 5_000, startDate, terms })
    rows[0]!.feesDue += fee
    rows[0]!.totalDue += fee
    const feesBefore = rows.reduce((s, r) => s + r.feesDue, 0)
    const plan = planInPlace({ loan: { principal: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 5_000, startDate }, rows, frequency: "MONTHLY", structure: "AMORTISING", change: { type: "RATE_CHANGE", interestRatePm: 0.04 }, asOf: NOW })
    expect(plan.rows.reduce((s, r) => s + r.feesDue, 0)).toBe(feesBefore)
  })

  it("a same-rate change after a FULL grace keeps the interest the grace deferred (already earned)", () => {
    const startDate = new Date("2026-02-01T10:00:00Z")
    const P = 1_000_000
    const input = { principalCents: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 0, startDate } as const
    const gen = generateSchedule({ ...input, terms: { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "FULL", graceInstalments: 3, instalments: 9 } })
    expect(gen.deferredInterest).toBe(120_000)
    const rows: PlanRow[] = gen.schedule.map((r, i) => ({ id: `r${i}`, installmentNo: r.installmentNo, dueDate: r.dueDate, principalDue: r.principalDue, interestDue: r.interestDue, feesDue: r.feesDue, totalDue: r.totalDue, totalPaid: r.dueDate <= NOW ? r.totalDue : 0, paidAt: null }))
    const paidDue = rows.filter((r) => r.totalPaid > 0).length
    const notDue = rows.length - paidDue
    const plan = planInPlace({ loan: { principal: P, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0, startDate }, rows, frequency: "MONTHLY", structure: "AMORTISING", change: { type: "RATE_CHANGE", interestRatePm: 0.04 }, asOf: NOW })
    const before = sum(rows)
    // Same rate, same rows: nothing should move by more than rounding.
    expect({ notDue, lost: before - plan.totalInterest }).toEqual({ notDue, lost: 0 })
  })
})

describe("fuzz, pure", () => {
  it("stacked changes and receipts: rows add up, nothing negative, what fell due is never forgiven", () => {
    let seed = 281
    const rnd = (n: number) => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n
    const bad: string[] = []
    for (let run = 0; run < 3000; run++) {
      const P = 1_000 + rnd(2_000_000)
      const n = 2 + rnd(24)
      const fee = rnd(3) === 0 ? 0 : rnd(10_000)
      const model = rnd(2) ? "REDUCING_BALANCE" as const : "FLAT" as const
      const rate = rnd(10) / 100
      let asOf = new Date("2026-06-01T10:00:00Z")
      const startDate = new Date(asOf.getTime() - rnd(200) * 86_400_000)
      const terms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: n } as const
      let rows: PlanRow[] = rowsOf({ principalCents: P, interestRatePm: rate, interestModel: model, monthlyServiceFeeCents: fee, startDate, terms })
      let current = rate
      for (let step = 0; step < 4; step++) {
        let cash = rnd(3) === 0 ? 0 : rnd(Math.ceil(rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0) * 0.7) + 1)
        rows = [...rows].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime() || a.installmentNo - b.installmentNo).map((r) => { const take = Math.min(cash, r.totalDue - r.totalPaid); cash -= take; return { ...r, totalPaid: r.totalPaid + take } })
        const day = new Date(asOf).getTime()
        const dueUnpaid = rows.filter((r) => r.dueDate.getTime() <= day && r.totalPaid < r.totalDue).reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
        const owedBefore = rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
        const principalPaidMax = rows.reduce((s, r) => s + r.principalDue, 0)
        const kind = rnd(4)
        const change = kind === 0 ? { type: "RATE_CHANGE" as const, interestRatePm: rnd(10) / 100 } : kind === 1 ? { type: "TERM_CHANGE" as const, instalments: 1 + rnd(36) } : kind === 2 ? { type: "PAYMENT_HOLIDAY" as const, holidayInstalments: 1 + rnd(3) } : { type: "RESTRUCTURE" as const, instalments: 1 + rnd(36), interestRatePm: rnd(10) / 100 }
        let plan
        try { plan = planInPlace({ loan: { principal: P, interestRatePm: current, interestModel: model, monthlyServiceFee: fee, startDate }, rows, frequency: "MONTHLY", structure: "AMORTISING", change, asOf }) } catch (e) { if (!/No principal/.test(String(e))) bad.push(`throw ${String(e)}`); break }
        const all = plan.rows
        const sumP = all.reduce((s, r) => s + r.principalDue, 0)
        if (sumP !== P || sumP !== principalPaidMax) bad.push(`principal ${run}/${step} ${sumP} vs ${P}`)
        if (all.some((r) => r.principalDue < 0 || r.interestDue < 0 || r.feesDue < 0 || r.totalDue !== r.principalDue + r.interestDue + r.feesDue)) bad.push(`negative ${run}/${step}`)
        const owedAfter = all.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
        if (owedAfter < dueUnpaid) bad.push(`forgiven ${run}/${step} owed ${owedAfter} dueUnpaid ${dueUnpaid} before ${owedBefore}`)
        if (all.reduce((s, r) => s + r.totalPaid, 0) !== rows.reduce((s, r) => s + r.totalPaid, 0)) bad.push(`paid moved ${run}/${step}`)
        rows = all.map((r, i) => ({ ...r, id: `x${step}_${i}`, paidAt: null }))
        current = plan.interestRatePm
        asOf = new Date(asOf.getTime() + (10 + rnd(50)) * 86_400_000)
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it("info: a same-rate change on a FLAT loan keeps the interest the contract priced for the remaining rows", () => {
    const startDate = new Date("2026-02-01T10:00:00Z")
    const P = 1_000_000
    const terms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments: 12 } as const
    const rows = rowsOf({ principalCents: P, interestRatePm: 0.04, interestModel: "FLAT", monthlyServiceFeeCents: 0, startDate, terms }).map((r) => ({ ...r, totalPaid: r.dueDate <= NOW ? r.totalDue : 0 }))
    const plan = planInPlace({ loan: { principal: P, interestRatePm: 0.04, interestModel: "FLAT", monthlyServiceFee: 0, startDate }, rows, frequency: "MONTHLY", structure: "AMORTISING", change: { type: "RATE_CHANGE", interestRatePm: 0.04 }, asOf: NOW })
    expect(plan.totalInterest).toBe(sum(rows))
  })
})

suite("loan changes, real Postgres", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  const pay = (l: LoanFixture, amount: number) => runWithTenant(l.tenantId, () => applyManualReceipt(holder.prisma as never, { loanId: l.loanId, tenantId: l.tenantId, amount, capturedById: l.fx.tenant.userId }))
  const newLoanOf = async (requestId: string) => (await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: requestId } })).newLoanId!
  const asFixture = (l: LoanFixture, loanId: string): LoanFixture => ({ ...l, loanId })

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  async function screened(l: LoanFixture) {
    await db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: "simulated" } })
    await runWithTenant(l.tenantId, () => runScreening({ tenantId: l.tenantId, subject: { clientId: l.fx.clientId }, trigger: "MANUAL", actor: null }))
  }

  it("TOP_UP: a borrower with a live manual KYC rejection gets no new money", async () => {
    const l = await bookLoan(db())
    await screened(l).catch((e) => { throw new Error(`screening setup: ${String(e)}`) })
    await db().client.update({ where: { id: l.fx.clientId }, data: { kycManualRejectionActive: true, kycManualRejectionAt: new Date(), kycManualRejectionById: l.fx.tenant.userId, kycManualRejectionReason: "Forged ID" } })
    const { id, submitted } = await draftAndSubmit(l, { type: "TOP_UP", newMoneyCents: 500_000, payoutReference: "EFT-KYC", instalments: 12 })
    if (submitted.status !== 200) { expect(submitted.status).toBe(422); return }
    as(l, "checker")
    const approved = await actionRoute(req({ note: "ok" }), params({ id, action: "approve" }))
    expect(approved.status).not.toBe(200)
  })

  it("in place: the product's maximum term binds a TERM_CHANGE, as it binds a refinance", async () => {
    const l = await bookLoan(db())
    await db().loanProduct.update({ where: { id: l.fx.tenant.productId }, data: { maxTermDays: 360 } })
    const { submitted } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 120 })
    expect(submitted.status).toBe(422)
    await db().loanProduct.update({ where: { id: l.fx.tenant.productId }, data: { maxTermDays: 1_800 } })
  })

  it("a Stage 3 borrower refinanced twice before the next run stays Stage 3", async () => {
    const a = await bookLoan(db(), { status: "DEFAULTED" })
    const first = await proposeAndApprove(a, { type: "REFINANCE", instalments: 12 })
    const b = await newLoanOf(first)
    const second = await proposeAndApprove(asFixture(a, b), { type: "REFINANCE", instalments: 12 })
    const c = await newLoanOf(second)
    const priors = new Map([[a.loanId, { stage: 3 as const, stageSince: "2026-01-31", cureStartedOn: null, restructured: false, runDate: "2026-10-31" }]])
    await inheritPriorStaging(db() as never, a.tenantId, priors)
    const loans = await loadRunLoans(db() as never, a.tenantId, new Date(), null)
    const loan = loans.find((x) => x.id === c)!
    const ctx = { runAt: new Date(), settings: DEFAULT_SETTINGS } as never
    const assessed = assessLoan(loan, ctx, priors.get(c) ?? null)
    expect({ prior: priors.get(c)?.stage ?? null, stage: assessed.staging.stage, marked: loan.restructuredOn }).toMatchObject({ prior: 3, stage: 3 })
  })

  it("a late MONTHLY run for the month before a restructure still sees the arrears of that month", async () => {
    const l = await bookLoan(db(), { monthsRun: 4, instalments: 6, status: "DEFAULTED" })
    // The month-end before: the change lands the next day, then the nightly make-up run for that month-end is made (lib/ifrs9/period.ts monthlyRunTarget).
    const asOf = new Date(Date.now() - 86_400_000)
    const beforeRows = await loadRunLoans(db() as never, l.tenantId, asOf, asOf)
    const ctx = { runAt: asOf, settings: DEFAULT_SETTINGS } as never
    const stageBefore = assessLoan(beforeRows.find((x) => x.id === l.loanId)!, ctx, null)
    expect(stageBefore.dpd).toBeGreaterThan(90)
    await new Promise((r) => setTimeout(r, 20))
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12 })
    const after = await loadRunLoans(db() as never, l.tenantId, asOf, asOf)
    const again = assessLoan(after.find((x) => x.id === l.loanId)!, ctx, null)
    expect({ dpd: again.dpd, stage: again.staging.stage }).toEqual({ dpd: stageBefore.dpd, stage: stageBefore.staging.stage })
  })

  it("reversing a cash receipt on a loan a refinance settled: no second balance is created for what the new loan already holds", async () => {
    const l = await bookLoan(db())
    await pay(l, 100_000)
    const payment = await db().payment.findFirstOrThrow({ where: { loanId: l.loanId, paymentMethod: { not: "LOAN_SETTLEMENT" } } })
    const id = await proposeAndApprove(l, { type: "REFINANCE", instalments: 12 })
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    as(l, "checker")
    const res = await reverseRoute(new NextRequest("http://lender.test/api", { method: "PATCH", body: JSON.stringify({ reason: "Bounced EFT at the bank" }) }), params({ id: payment.id }))
    const body = await res.json()
    const old = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    const rows = await db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })
    const live = await db().loan.count({ where: { id: { in: [l.loanId, change.newLoanId!] }, status: { in: ["ACTIVE", "DEFAULTED"] } } })
    process.stderr.write("\nBRK "+" reversal "+JSON.stringify({ status: res.status, body, oldStatus: old.status, outstanding: old.outstandingPrincipal, settled: change.settledCents, rowsDue: rows.reduce((s, r) => s + r.totalDue, 0), rowsPaid: rows.reduce((s, r) => s + r.totalPaid, 0), live })+"\n")
    // Either refused, or the old loan owes exactly the bounced 100,000 and not the s125 rebate as well.
    if (res.status === 200) expect(rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)).toBe(100_000)
  })

  it("reversing a pre-change receipt on a restructured loan leaves rows that still reconcile", async () => {
    const l = await bookLoan(db(), { monthsRun: 3 })
    await pay(l, 150_000)
    const payment = await db().payment.findFirstOrThrow({ where: { loanId: l.loanId } })
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12 })
    const rowsBefore = await db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })
    const owedBefore = rowsBefore.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)
    as(l, "checker")
    const res = await reverseRoute(new NextRequest("http://lender.test/api", { method: "PATCH", body: JSON.stringify({ reason: "Bounced EFT at the bank" }) }), params({ id: payment.id }))
    const rows = await db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })
    const row = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    process.stderr.write("\nBRK "+" reverse in place "+JSON.stringify({ status: res.status, owedBefore, owed: rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0), totalPaid: row.totalPaid, sumPrincipal: rows.reduce((s, r) => s + r.principalDue, 0), principal: row.principal, outstanding: row.outstandingPrincipal })+"\n")
    expect(res.status).toBe(200)
    expect(rows.reduce((s, r) => s + r.totalDue - r.totalPaid, 0)).toBe(owedBefore + 150_000)
  })

  it("guardLoanTerms binds a later row to the request of THAT loan", async () => {
    const a = await bookLoan(db())
    const b = await bookLoan(db(), { sameClientAs: a })
    const request = await proposeAndApprove(a, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    await db().loanTerms.create({ data: { tenantId: a.tenantId, loanId: b.loanId, sequence: 1, changeRequestId: request, baseRatePm: 0.04, interestRatePm: 0.04 } }).catch(() => undefined)
    await expect(db().loanTerms.create({ data: { tenantId: a.tenantId, loanId: b.loanId, sequence: 2, changeRequestId: request, baseRatePm: 0.99, interestRatePm: 0.99 } })).rejects.toThrow()
  })

  it("controls: the maker cannot approve; approve twice; a second change on the old base is STALE; other tenant is not found", async () => {
    const l = await bookLoan(db())
    const one = await draftAndSubmit(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    const two = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 12 })
    as(l, "maker")
    holder.user.role = "ADMIN"
    expect((await actionRoute(req({ note: "mine" }), params({ id: one.id, action: "approve" }))).status).toBe(403)
    as(l, "checker")
    expect((await actionRoute(req({ note: "ok" }), params({ id: one.id, action: "approve" }))).status).toBe(200)
    expect((await actionRoute(req({ note: "ok" }), params({ id: one.id, action: "approve" }))).status).toBe(409)
    expect((await actionRoute(req({ note: "ok" }), params({ id: two.id, action: "approve" }))).status).toBe(409)
    const other = await bookLoan(db())
    as(other, "checker")
    expect((await actionRoute(req({ note: "x" }), params({ id: randomUUID(), action: "approve" }))).status).toBe(404)
    expect(addCalendarMonths).toBeDefined()
  })

  it("concurrent approvals of two changes on one loan: exactly one applies", async () => {
    const l = await bookLoan(db())
    const one = await draftAndSubmit(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    const two = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 12 })
    as(l, "checker")
    const res = await Promise.all([one.id, two.id].map((id) => actionRoute(req({ note: "ok" }), params({ id, action: "approve" }))))
    expect(res.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await db().loanChange.count({ where: { loanId: l.loanId } })).toBe(1)
  })
})
