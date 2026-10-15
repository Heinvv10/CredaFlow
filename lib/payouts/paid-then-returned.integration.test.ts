/**
 * Real-Postgres proof for the PR #89 accounting review on returns:
 *  (a) a RETURNED report after a PAID one on an attempt already over is the
 *      later, final fact: stored as PAID_THEN_RETURNED (nets to not paid),
 *      never overwritten, never resolvable as paid or as a recovery, and not
 *      a double-payout risk;
 *  (b) staff confirm a PAID attempt as RETURNED at a bank value date, by a
 *      second person (code and database), and the export reverses clearing
 *      to bank from that date;
 *  and a later attempt PAID beside a provider PAID report on an earlier one
 *  is an alert on the loan's payout view.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/paid-then-returned.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { prisma } from "@/lib/prisma"
import { loadSourceLoans } from "@/lib/accounting/store"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { loadDoublePayoutRisks } from "./double-payout"
import { failedPayoutLoan } from "./payouts.integration-fixture"
import { applyProviderState, resolvePayout } from "./resolve"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import type { ProviderPayoutState } from "./types"
import { loadPayoutView } from "./view"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
const user = (suffix: string) => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const disburser = () => user("")
const requester = () => user("-req")
const checker = () => user("-chk")
const resolver = () => user("-res")

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}
const report = async (payoutId: string, state: ProviderPayoutState) =>
  applyProviderState(prisma, { tenantId: tenant.tenantId, payout: await db.disbursementPayout.findUniqueOrThrow({ where: { id: payoutId } }), state, source: "webhook", actor: { id: null, email: "webhook:simulated" } })
const row = (id: string) => db.disbursementPayout.findUniqueOrThrow({ where: { id } })
const resolveSeen = async (payoutId: string, outcome: "paid" | "not_paid" | "recovery") => {
  const r = await row(payoutId)
  return resolvePayout(prisma, {
    tenantId: tenant.tenantId, payoutId, actor: resolver(),
    request: { action: "resolve_conflict", outcome, note: "Checked the bank statement", seen: { state: r.providerConflictState!, at: r.providerConflictAt! } },
  })
}
/** Attempt 2 of a failed loan, approved, sent and PAID. */
async function paidRetry() {
  const loan = await failedPayoutLoan(db, tenant, disburser())
  const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
  const retryId = (req as { payoutId: string }).payoutId
  await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: checker() })
  await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date() } })
  await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "PAID", paidAt: new Date("2026-10-10T10:00:00+02:00") } })
  return { ...loan, retryId }
}

suite.sequential("a payout paid, then returned (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const u of [requester(), checker(), resolver()]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("(a) stores a RETURNED after a PAID as PAID_THEN_RETURNED: final, never paid or recovered, resolvable as not paid", async () => {
    const loan = await failedPayoutLoan(db, tenant, disburser())
    await report(loan.payoutId, "PAID")
    expect(await report(loan.payoutId, "RETURNED")).toMatchObject({ conflict: true, report: "returned_after_paid" })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID_THEN_RETURNED", conflictResolvedAt: null })
    expect(await report(loan.payoutId, "PAID")).toMatchObject({ report: "dropped" })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID_THEN_RETURNED" })
    // The database: nothing overwrites it.
    const r = await row(loan.payoutId)
    await refused(db.disbursementPayout.update({ where: { id: loan.payoutId }, data: { providerConflictState: "PAID", providerConflictAt: new Date(r.providerConflictAt!.getTime() + 1000), providerConflictDetail: "x" } }), /terms never change/)
    expect(await resolveSeen(loan.payoutId, "paid")).toMatchObject({ ok: false, status: 422 })
    expect((await loadPayoutView(tenant.tenantId, loan.loanId, "ACTIVE"))?.attempts[0].conflict).toMatchObject({ state: "PAID_THEN_RETURNED" })
    expect(await resolveSeen(loan.payoutId, "not_paid")).toMatchObject({ ok: true })
  })

  it("(a) is not a double-payout risk once the money came back", async () => {
    const loan = await paidRetry()
    await report(loan.payoutId, "PAID")
    expect((await loadDoublePayoutRisks(prisma, tenant.tenantId)).filter((x) => x.loanId === loan.loanId)).toHaveLength(1)
    await report(loan.payoutId, "RETURNED")
    expect((await loadDoublePayoutRisks(prisma, tenant.tenantId)).filter((x) => x.loanId === loan.loanId)).toHaveLength(0)
  })

  it("(b) staff confirm a PAID attempt RETURNED at the bank value date, by a second person, and the export reverses it from then", async () => {
    const loan = await paidRetry()
    const backOn = new Date("2026-10-12T12:00:00+02:00")
    const confirm = (actor: ReturnType<typeof user>) => resolvePayout(prisma, {
      tenantId: tenant.tenantId, payoutId: loan.retryId, actor,
      request: { action: "confirm_returned", note: "Bank statement shows the credit reversed", returnedAt: backOn },
    })
    expect(await confirm(checker())).toMatchObject({ ok: false, status: 403 })
    expect(await confirm(requester())).toMatchObject({ ok: false, status: 403 })
    expect(await confirm(resolver())).toMatchObject({ ok: true, status: "RETURNED" })
    expect(await row(loan.retryId)).toMatchObject({ status: "RETURNED", returnedAt: backOn, returnedById: resolver().id })
    expect(await confirm(resolver())).toMatchObject({ ok: false, status: 409 })
    const source = (await loadSourceLoans(prisma, tenant.tenantId, new Date())).find((l) => l.id === loan.loanId)
    expect(source?.payouts.find((p) => p.id === loan.retryId)).toMatchObject({ returnedAt: backOn })
  })

  it("(b) the database refuses a staff return by the attempt's makers, or without a note", async () => {
    const loan = await paidRetry()
    const back = { status: "RETURNED" as const, returnedAt: new Date() }
    await refused(db.disbursementPayout.update({ where: { id: loan.retryId }, data: { ...back, returnedById: checker().id, returnNote: "self" } }), /cannot settle/)
    await refused(db.disbursementPayout.update({ where: { id: loan.retryId }, data: { ...back, returnedById: resolver().id } }), /named person with a note/)
    await db.disbursementPayout.update({ where: { id: loan.retryId }, data: { ...back, returnedById: resolver().id, returnNote: "Credit reversed" } })
  })

  it("alerts on the loan when a later attempt is PAID while the provider reports an earlier one paid", async () => {
    const loan = await paidRetry()
    expect((await loadPayoutView(tenant.tenantId, loan.loanId, "ACTIVE"))?.doublePayout).toEqual([])
    await report(loan.payoutId, "PAID")
    expect((await loadPayoutView(tenant.tenantId, loan.loanId, "ACTIVE"))?.doublePayout).toEqual([
      expect.objectContaining({ attempt: 1, reported: "PAID", liveAttempt: 2, liveStatus: "PAID" }),
    ])
  })
})
