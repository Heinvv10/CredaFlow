/**
 * Real-Postgres proof for the PR #89 breaker re-attack on provider reports
 * about an attempt already over (FAILED/CANCELLED):
 *  X1 a stale SUBMITTED/PROCESSING is audited, never stored as a conflict, so
 *     it cannot mask a later PAID; a stronger report (PAID > RETURNED)
 *     overwrites an unresolved conflict, a weaker one is dropped; all audited;
 *  X2 a PAID/RETURNED report after a conflict was resolved "not paid" reopens
 *     it, which blocks retry, reversal and sending again;
 *  and a conflict on an earlier attempt while a later attempt is live is
 *  listed as a possible double payout.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/conflict-reports.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { prisma } from "@/lib/prisma"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { recordProviderConflict } from "./conflicts"
import { createDisbursementPayout } from "./disbursement"
import { dispatchPayout } from "./dispatch"
import { loadDoublePayoutRisks } from "./double-payout"
import { applyProviderState, resolvePayout } from "./resolve"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"
import type { ProviderPayoutState } from "./types"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
const user = (suffix: string) => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const disburser = () => user("")
const requester = () => user("-req")
const checker = () => user("-chk")
const resolver = () => user("-res")
const webhook = { id: null, email: "webhook:simulated" }

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}

/** An engine-disbursed loan whose first payout FAILED, with a fresh passing AVS. */
async function failedLoan() {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true, clientId: true } })
  const client = await db.client.update({ where: { id: loan.clientId! }, data: { bankName: "FNB", bankBranchCode: "250655", bankAccountNumber: "62000001111", accountType: "SAVINGS" } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "simulated", amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser(), avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-1111` } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
  await new Promise((r) => setTimeout(r, 5))
  await db.avsCheck.create({ data: {
    tenantId: tenant.tenantId, clientId: client.id, applicationId: loan.applicationId, provider: "netcash", subjectFingerprint: avsSubjectFingerprint(client),
    accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS", passed: true, checks: {},
  } })
  return { loanId: ids.loanId, applicationId: loan.applicationId, payoutId: id, reference: loan.reference }
}
const report = async (payoutId: string, state: ProviderPayoutState) =>
  applyProviderState(prisma, { tenantId: tenant.tenantId, payout: await db.disbursementPayout.findUniqueOrThrow({ where: { id: payoutId } }), state, source: "webhook", actor: webhook })
const row = (id: string) => db.disbursementPayout.findUniqueOrThrow({ where: { id } })
const audits = (id: string, action: string) => db.auditLog.findMany({ where: { entityId: id, action }, orderBy: { createdAt: "asc" } })
const resolveAs = (payoutId: string, outcome: "paid" | "not_paid") =>
  resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId, actor: resolver(), request: { action: "resolve_conflict", outcome, note: "Checked the bank statement" } })

suite.sequential("provider reports on an attempt already over (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const u of [requester(), checker(), resolver()]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("X1: audits a stale SUBMITTED/PROCESSING without storing it, so a later PAID is recorded and can be resolved as paid", async () => {
    const loan = await failedLoan()
    expect(await report(loan.payoutId, "PROCESSING")).toMatchObject({ status: "FAILED", changed: false, report: "stale" })
    expect(await report(loan.payoutId, "SUBMITTED")).toMatchObject({ report: "stale" })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictAt: null, providerConflictState: null })
    expect(await audits(loan.payoutId, "PAYOUT_PROVIDER_REPORT_IGNORED")).toHaveLength(2)
    expect(await report(loan.payoutId, "PAID")).toMatchObject({ conflict: true, report: "recorded" })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID" })
    expect(await resolveAs(loan.payoutId, "paid")).toMatchObject({ ok: true, status: "PAID" })
  })

  it("X1: a stronger report overwrites an unresolved conflict (PAID over RETURNED); a RETURNED after the PAID is kept as the final fact; every report audited", async () => {
    const loan = await failedLoan()
    expect(await report(loan.payoutId, "RETURNED")).toMatchObject({ report: "recorded" })
    expect(await report(loan.payoutId, "PAID")).toMatchObject({ conflict: true, report: "strengthened" })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID", conflictResolvedAt: null })
    // Paid, then returned: the later, final fact for this attempt (accounting review).
    expect(await report(loan.payoutId, "RETURNED")).toMatchObject({ conflict: true, report: "returned_after_paid" })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID_THEN_RETURNED", conflictResolvedAt: null })
    expect(await report(loan.payoutId, "RETURNED")).toMatchObject({ report: "dropped" })
    const outcomes = (await audits(loan.payoutId, "PAYOUT_PROVIDER_CONFLICT")).map((a) => (a.newValue as { outcome: string }).outcome)
    expect(outcomes).toEqual(["recorded", "strengthened", "returned_after_paid", "dropped"])
  })

  it("X2: a PAID report after a conflict was resolved not paid reopens it and blocks retry, reversal and sending again", async () => {
    const loan = await failedLoan()
    await report(loan.payoutId, "PAID")
    expect(await resolveAs(loan.payoutId, "not_paid")).toMatchObject({ ok: true })
    // A retry is requested and approved, waiting to send.
    const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
    const retryId = (req as { payoutId: string }).payoutId
    expect(await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: checker() })).toMatchObject({ ok: true, status: "PENDING" })
    await new Promise((r) => setTimeout(r, 5))
    expect(await recordProviderConflict(prisma, { tenantId: tenant.tenantId, payout: await row(loan.payoutId), state: "PAID", source: "webhook", actor: webhook })).toBe("reopened")
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID", conflictResolvedAt: null, conflictResolvedById: null })
    expect(await dispatchPayout(prisma, { tenantId: tenant.tenantId, payoutId: retryId, actor: checker() })).toMatchObject({ kind: "not_sendable" })
    await refused(db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date() } }), /resolve that first/)
    expect(await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says it never arrived", actor: requester() })).toMatchObject({ ok: false, status: 409 })
    expect((await audits(loan.payoutId, "PAYOUT_PROVIDER_CONFLICT")).map((a) => (a.newValue as { outcome: string }).outcome)).toEqual(["recorded", "reopened"])
  })

  it("X2: the database reopens a resolved conflict only on a newer report, never by clearing the resolution alone", async () => {
    const loan = await failedLoan()
    await report(loan.payoutId, "PAID")
    await resolveAs(loan.payoutId, "not_paid")
    const resolved = await row(loan.payoutId)
    const clear = { conflictResolvedAt: null, conflictResolvedById: null, conflictResolutionNote: null }
    await refused(db.disbursementPayout.update({ where: { id: loan.payoutId }, data: clear }), /terms never change/)
    await refused(db.disbursementPayout.update({ where: { id: loan.payoutId }, data: { ...clear, providerConflictState: "PROCESSING", providerConflictAt: new Date(), providerConflictDetail: "x" } }), /terms never change/)
    await db.disbursementPayout.update({ where: { id: loan.payoutId }, data: { ...clear, providerConflictAt: new Date(resolved.conflictResolvedAt!.getTime() + 1000), providerConflictDetail: "webhook reported PAID again" } })
    expect(await row(loan.payoutId)).toMatchObject({ conflictResolvedAt: null, providerConflictState: "PAID" })
  })

  it("X2: drops a report on an attempt whose money is already a recovery case, and audits it", async () => {
    const loan = await failedLoan()
    const rev = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says the account is closed", actor: requester() })
    await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: (rev as { reversalId: string }).reversalId, approve: true, note: "Confirmed", actor: checker() })
    await report(loan.payoutId, "PAID")
    expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: loan.payoutId, actor: resolver(), request: { action: "resolve_conflict", outcome: "recovery", note: "It left on the 8th" } })).toMatchObject({ ok: true })
    expect(await report(loan.payoutId, "PAID")).toMatchObject({ report: "dropped" })
    expect(await row(loan.payoutId)).toMatchObject({ conflictResolvedById: resolver().id })
  })

  it("lists a conflict on an earlier attempt while a later attempt is live as a possible double payout", async () => {
    const loan = await failedLoan()
    const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
    const retryId = (req as { payoutId: string }).payoutId
    await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: checker() })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date() } })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "PAID", paidAt: new Date() } })
    expect((await loadDoublePayoutRisks(prisma, tenant.tenantId)).some((r) => r.loanId === loan.loanId)).toBe(false)
    await report(loan.payoutId, "PAID")
    const risks = (await loadDoublePayoutRisks(prisma, tenant.tenantId)).filter((r) => r.loanId === loan.loanId)
    expect(risks).toEqual([expect.objectContaining({ payoutId: loan.payoutId, attempt: 1, reported: "PAID", liveAttempt: 2, liveStatus: "PAID", reference: loan.reference })])
  })

  // ── Stale decisions (scan: TOCTOU on resolution) ──

  const resolveSeen = (payoutId: string, outcome: "paid" | "not_paid", seen: { providerConflictState: string | null; providerConflictAt: Date | null }) =>
    resolvePayout(prisma, {
      tenantId: tenant.tenantId, payoutId, actor: resolver(),
      request: { action: "resolve_conflict", outcome, note: "Checked the bank statement", seen: { state: seen.providerConflictState!, at: seen.providerConflictAt! } },
    })

  it("refuses a not-paid decision made on an older report once a stronger one landed, and the PAID report stays blocking", async () => {
    const loan = await failedLoan()
    await report(loan.payoutId, "RETURNED")
    const seenByStaff = await row(loan.payoutId)
    await new Promise((r) => setTimeout(r, 5))
    expect(await report(loan.payoutId, "PAID")).toMatchObject({ report: "strengthened" })
    expect(await resolveSeen(loan.payoutId, "not_paid", seenByStaff)).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("reported again") })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID", conflictResolvedAt: null })
    expect(await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })).toMatchObject({ ok: false, status: 409 })
    // Decided on what is there now, it goes through.
    expect(await resolveSeen(loan.payoutId, "not_paid", await row(loan.payoutId))).toMatchObject({ ok: true })
  })

  it("never ends with a PAID report resolved by a decision made before it arrived, however the two race", async () => {
    for (let i = 0; i < 6; i++) {
      const loan = await failedLoan()
      await report(loan.payoutId, "RETURNED")
      const seenByStaff = await row(loan.payoutId)
      await new Promise((r) => setTimeout(r, 5))
      await Promise.allSettled([report(loan.payoutId, "PAID"), resolveSeen(loan.payoutId, "not_paid", seenByStaff)])
      // Either the PAID report strengthened the open conflict (and the stale
      // decision was refused) or it reopened the resolved one: both block.
      expect(await row(loan.payoutId), `race ${i}`).toMatchObject({ providerConflictState: "PAID", conflictResolvedAt: null })
    }
  })
})
