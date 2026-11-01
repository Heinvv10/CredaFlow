/**
 * Real-Postgres proof of loan changes (migration 20261101100100_loan_changes): a change passes the credit gates at approval, stays
 * inside its product, and a bounced receipt on a loan a new loan settled leaves exactly its amount owed.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/
 *
 * Its own throwaway database: the role needs CREATEDB. Only the session is stood in for.
 */
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true }, settlementOffset: 0 }))
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
// Lets one test price a settlement short of what closes the loan.
vi.mock("@/lib/loan/charges-summary", async (original) => {
  const actual = await original<typeof import("@/lib/loan/charges-summary")>()
  return { ...actual, loanSettlementFigures: async (...args: Parameters<typeof actual.loanSettlementFigures>) => {
    const figures = await actual.loanSettlementFigures(...args)
    return { ...figures, totalToSettle: figures.totalToSettle + holder.settlementOffset }
  } }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { PATCH as reverseRoute } from "@/app/api/payments/[id]/reverse/route"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { GET as changesRoute } from "@/app/api/loans/[id]/changes/route"
import { applyManualReceipt, applyManualReceiptInTx } from "@/lib/loan/apply-payment"
import { bookLoan, changeRoutes, type LoanFixture, type LoanOptions } from "./loan-changes.integration-fixture"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { as, req, params, draftAndSubmit, proposeAndApprove } = changeRoutes(holder)

suite("loan changes: credit gates and bounds (real Postgres, real routes)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  const loan = (opts?: LoanOptions) => bookLoan(db(), opts)
  const pay = (l: LoanFixture, amount: number) => runWithTenant(l.tenantId, () => applyManualReceipt(holder.prisma as never, { loanId: l.loanId, tenantId: l.tenantId, amount, capturedById: l.fx.tenant.userId }))
  const refinance = { type: "REFINANCE", instalments: 12 }

  /** Submitted, then refused at the checker's approval: what held at submission may not hold then. */
  async function refusedAtApproval(l: LoanFixture, payload: Record<string, unknown>, regress: () => Promise<unknown>, reason: RegExp) {
    const { id, submitted } = await draftAndSubmit(l, payload)
    expect(submitted.status).toBe(200)
    await regress()
    as(l, "checker")
    const refused = await actionRoute(req({}), params({ id, action: "approve" }))
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { error: string }).error).toMatch(reason)
    expect(await db().loanChange.count({ where: { changeRequestId: id } })).toBe(0)
    expect((await db().changeRequest.findUniqueOrThrow({ where: { id } })).status).toBe("SUBMITTED")
  }

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("a manual KYC rejection after submission stops a refinance at approval", async () => {
    const l = await loan()
    await refusedAtApproval(l, refinance, () => db().client.update({
      where: { id: l.fx.clientId }, data: { kycManualRejectionActive: true, kycManualRejectionAt: new Date(), kycManualRejectionById: l.fx.tenant.userId, kycManualRejectionReason: "Forged ID" },
    }), /manually rejected/)
  })

  it("a core KYC document no longer verified stops a refinance at approval", async () => {
    const l = await loan()
    await refusedAtApproval(l, refinance, () => db().clientDocument.updateMany({ where: { clientId: l.fx.clientId, docType: "PAYSLIP" }, data: { verified: false } }), /KYC is not complete/)
  })

  it("a borrower recorded as deceased, or a retired product, stops a refinance at approval", async () => {
    const l = await loan()
    await refusedAtApproval(l, refinance, () => db().client.update({ where: { id: l.fx.clientId }, data: { deceasedAt: new Date() } }), /deceased/)
    const m = await loan()
    await refusedAtApproval(m, refinance, () => db().loanProduct.update({ where: { id: m.fx.tenant.productId }, data: { active: false } }), /no longer offered/)
    await db().loanProduct.update({ where: { id: m.fx.tenant.productId }, data: { active: true } })
  })

  it("screening that now blocks stops a refinance at approval", async () => {
    const l = await loan()
    await refusedAtApproval(l, refinance, () => db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: "simulated" } }), /./)
    await db().tenantConfig.update({ where: { tenantId: l.tenantId }, data: { screeningProvider: null } })
  })

  it("a new loan stays inside the product's maximum amount and term", async () => {
    const l = await loan()
    await db().loanProduct.update({ where: { id: l.fx.tenant.productId }, data: { maxAmount: 100_000 } })
    const big = (await draftAndSubmit(l, refinance)).submitted
    expect(big.status).toBe(422)
    expect(((await big.json()) as { error: string }).error).toMatch(/maximum amount/)
    await db().loanProduct.update({ where: { id: l.fx.tenant.productId }, data: { maxAmount: 100_000_000, maxTermDays: 300 } })
    const long = (await draftAndSubmit(l, refinance)).submitted
    expect(((await long.json()) as { error: string }).error).toMatch(/maximum term/)
  })

  it("a change in place stays inside the product's maximum term", async () => {
    const l = await loan()
    await db().loanProduct.update({ where: { id: l.fx.tenant.productId }, data: { maxTermDays: 360 } })
    const { submitted } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 120 })
    expect(submitted.status).toBe(422)
    expect(((await submitted.json()) as { error: string }).error).toMatch(/maximum term/)
  })

  it("no proposal raises a rate above the product's and the loan's own; below them it is what the new loan charges", async () => {
    const l = await loan()
    await db().loanProduct.update({ where: { id: l.fx.tenant.productId }, data: { interestRatePm: 0.05 } })
    const high = (await draftAndSubmit(l, { type: "RATE_CHANGE", interestRatePm: 0.06 })).submitted
    expect(high.status).toBe(422)
    expect(((await high.json()) as { error: string }).error).toMatch(/above the product/)
    const id = await proposeAndApprove(l, { type: "REFINANCE", instalments: 12, interestRatePm: 0.03 })
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    expect((await db().loan.findUniqueOrThrow({ where: { id: change.newLoanId! } })).interestRatePm).toBe(0.03)
  })

  it("a consolidation refuses another borrower's loan under the same lender, and a loan that could not be changed", async () => {
    const a = await loan()
    const sameLender = await loan({ sameClientAs: a })
    await db().paymentArrangement.create({
      data: { tenantId: a.tenantId, loanId: sameLender.loanId, arrangementDate: new Date(), agreedAmount: 100, frequency: "MONTHLY", startDate: new Date(), endDate: new Date(), status: "ACTIVE" },
    })
    const ineligible = (await draftAndSubmit(a, { type: "CONSOLIDATION", otherLoanIds: [sameLender.loanId], instalments: 18 })).submitted
    expect(ineligible.status).toBe(422)
    expect(((await ineligible.json()) as { error: string }).error).toMatch(/arrangement/)

    const third = await loan({ sameLenderAs: a })
    const stranger = (await draftAndSubmit(a, { type: "CONSOLIDATION", otherLoanIds: [third.loanId], instalments: 18 })).submitted
    expect(stranger.status).toBe(422)
    expect(((await stranger.json()) as { error: string }).error).toMatch(/one borrower/)
  })

  it("the signed paper must be the borrower's own, on file, and not an ID copy", async () => {
    const a = await loan()
    const stranger = await loan({ sameLenderAs: a })
    expect((await draftAndSubmit(a, { type: "RATE_CHANGE", interestRatePm: 0.03, signedDocumentId: stranger.documentId })).submitted.status).toBe(422)
    const idCopy = await db().clientDocument.findFirstOrThrow({ where: { clientId: a.fx.clientId, docType: "ID_COPY" } })
    expect((await draftAndSubmit(a, { type: "RATE_CHANGE", interestRatePm: 0.03, signedDocumentId: idCopy.id })).submitted.status).toBe(422)
    await db().clientDocument.update({ where: { id: a.documentId }, data: { deletedAt: new Date() } })
    expect((await draftAndSubmit(a, { type: "RATE_CHANGE", interestRatePm: 0.03 })).submitted.status).toBe(422)
  })

  it("the checker can open the signed document from the proposal; the maker is not offered the approval, whatever their role", async () => {
    const l = await loan()
    await draftAndSubmit(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
    holder.user = { ...holder.user, role: "SUPER_ADMIN" }
    const mine = await (await changesRoute(req(), params({ id: l.loanId }))).json() as { requests: Array<{ canApprove: boolean; mine: boolean }> }
    expect(mine.requests[0]).toMatchObject({ mine: true, canApprove: false })
    as(l, "checker")
    const theirs = await (await changesRoute(req(), params({ id: l.loanId }))).json() as { requests: Array<{ canApprove: boolean; signedDocument: { id: string; fileName: string } }> }
    expect(theirs.requests[0]).toMatchObject({ canApprove: true, signedDocument: { id: l.documentId, fileName: "signed-variation.pdf" } })
  })

  it("a loan that changed status since submission makes the change stale", async () => {
    const l = await loan()
    const { id } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 12 })
    await db().loan.update({ where: { id: l.loanId }, data: { status: "DEFAULTED" } })
    as(l, "checker")
    expect((await actionRoute(req({}), params({ id, action: "approve" }))).status).toBe(409)
  })

  it("if the settlement does not close the old loan, nothing is changed", async () => {
    const l = await loan()
    const { id } = await draftAndSubmit(l, refinance)
    holder.settlementOffset = -1
    as(l, "checker")
    const refused = await actionRoute(req({}), params({ id, action: "approve" }))
    holder.settlementOffset = 0
    expect(refused.status).toBe(422)
    expect(((await refused.json()) as { error: string }).error).toMatch(/did not settle/)
    expect((await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })).status).toBe("ACTIVE")
    expect(await db().payment.count({ where: { loanId: l.loanId } })).toBe(0)
  })

  it("the approval reads the loan under its lock: a receipt that lands first is in the plan, not lost", async () => {
    const l = await loan()
    const { id } = await draftAndSubmit(l, { type: "TERM_CHANGE", instalments: 12 })
    as(l, "checker")
    const client = holder.prisma as { $transaction: <T>(fn: (tx: never) => Promise<T>, options?: { timeout: number }) => Promise<T> }
    let approving: Promise<Response> | null = null
    await runWithTenant(l.tenantId, () => client.$transaction(async (tx) => {
      await (tx as unknown as { $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown> }).$queryRaw`SELECT 1 FROM "Loan" WHERE id = ${l.loanId} FOR UPDATE`
      approving = actionRoute(req({}), params({ id, action: "approve" })) as Promise<Response>
      // The approval is waiting on the lock now: this receipt commits before it reads anything.
      await new Promise((resolve) => setTimeout(resolve, 1_000))
      await applyManualReceiptInTx(tx, { loanId: l.loanId, tenantId: l.tenantId, amount: 100_000, capturedById: l.fx.tenant.userId })
    }, { timeout: 4_000 }))
    expect((await approving!).status).toBe(200)
    const [row, rows] = await Promise.all([db().loan.findUniqueOrThrow({ where: { id: l.loanId } }), db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })])
    expect(row.totalPaid).toBe(100_000)
    expect(rows.reduce((sum, r) => sum + r.totalPaid, 0)).toBe(100_000)
    expect(rows.reduce((sum, r) => sum + r.principalDue, 0)).toBe(row.principal)
  })

  it("a bounced receipt on a loan a new loan settled leaves exactly its amount owed, on the old loan", async () => {
    const l = await loan()
    await pay(l, 100_000)
    const receipt = await db().payment.findFirstOrThrow({ where: { loanId: l.loanId } })
    const id = await proposeAndApprove(l, refinance)
    const change = await db().loanChange.findUniqueOrThrow({ where: { changeRequestId: id } })
    as(l, "checker")
    const res = await reverseRoute(new NextRequest("http://lender.test/api", { method: "PATCH", body: JSON.stringify({ reason: "Bounced EFT at the bank" }) }), params({ id: receipt.id }))
    expect(res.status).toBe(200)
    const old = await db().loan.findUniqueOrThrow({ where: { id: l.loanId } })
    const rows = await db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })
    expect(rows.reduce((sum, r) => sum + r.totalDue - r.totalPaid, 0)).toBe(100_000)
    expect(old).toMatchObject({ status: "ACTIVE", closedAt: null, totalRepayable: rows.reduce((sum, r) => sum + r.totalDue, 0) })
    // The new loan is not touched, and the settlement stands.
    expect((await db().loan.findUniqueOrThrow({ where: { id: change.newLoanId! } })).status).toBe("ACTIVE")
    expect(await db().payment.count({ where: { loanId: l.loanId, paymentMethod: "LOAN_SETTLEMENT", reversed: false } })).toBe(1)
  })

  it("a reversal of a receipt from before a restructure leaves rows that still add up", async () => {
    const l = await loan()
    await pay(l, 150_000)
    const receipt = await db().payment.findFirstOrThrow({ where: { loanId: l.loanId } })
    await proposeAndApprove(l, { type: "RESTRUCTURE", instalments: 12 })
    const owed = async () => (await db().repaymentSchedule.findMany({ where: { loanId: l.loanId } })).reduce((sum, r) => sum + r.totalDue - r.totalPaid, 0)
    const before = await owed()
    as(l, "checker")
    expect((await reverseRoute(new NextRequest("http://lender.test/api", { method: "PATCH", body: JSON.stringify({ reason: "Bounced EFT at the bank" }) }), params({ id: receipt.id }))).status).toBe(200)
    expect(await owed()).toBe(before + 150_000)
  })
})
