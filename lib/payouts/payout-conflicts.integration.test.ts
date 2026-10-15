/**
 * Real-Postgres proof against the breaker's re-attack (PR #89 round 2):
 *  - no payout attempt can exist on a CANCELLED loan or beside an open
 *    reversal, even when a retry and a reversal race;
 *  - a provider reporting money moved on an attempt already over is
 *    recorded, audited, and blocks retries and reversals until a second
 *    person resolves it;
 *  - nobody who disbursed, requested or approved an attempt settles it.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/payout-conflicts.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { prisma } from "@/lib/prisma"
import { avsSubjectFingerprint } from "@/lib/compliance/avs-subject"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createDisbursementPayout } from "./disbursement"
import { applyProviderState, resolvePayout } from "./resolve"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
const user = (suffix: string) => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const disburser = () => user("")
const requester = () => user("-req")
const checker = () => user("-chk")

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}

/** An engine-disbursed loan whose first payout (simulated, account suffix `tail`) FAILED, with a fresh passing AVS. */
async function failedLoan(tail = "1111") {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true, clientId: true } })
  const client = await db.client.update({ where: { id: loan.clientId! }, data: { bankName: "FNB", bankBranchCode: "250655", bankAccountNumber: "62000005678", accountType: "SAVINGS" } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "simulated",
    amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: `6200000${tail}`, accountType: "SAVINGS" },
    user: disburser(), avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-${tail}` } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
  await new Promise((r) => setTimeout(r, 5))
  await db.avsCheck.create({ data: {
    tenantId: tenant.tenantId, clientId: client.id, applicationId: loan.applicationId, provider: "netcash", subjectFingerprint: avsSubjectFingerprint(client),
    accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000005678", accountType: "SAVINGS", passed: true, checks: {},
  } })
  return { loanId: ids.loanId, applicationId: loan.applicationId, payoutId: id }
}
const reverse = async (loanId: string) => {
  const req = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId, reason: "The bank says the account is closed", actor: requester() })
  if (!req.ok) return req
  return decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: req.reversalId, approve: true, note: "Confirmed with the bank", actor: checker() })
}

suite.sequential("payout conflicts and races (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const u of [requester(), checker()]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("refuses, in the database, a payout attempt beside an open reversal or on a CANCELLED loan", async () => {
    const loan = await failedLoan()
    const req = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says the account is closed", actor: requester() })
    expect(req.ok).toBe(true)
    const attempt = (n: number) => ({
      tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: loan.loanId, attempt: n, retryOfId: loan.payoutId,
      provider: "simulated", idempotencyKey: `disburse:${loan.applicationId}:${n}`, amountCents: 200_000, reference: "R",
      accountHolder: "A", bankName: "B", branchCode: "1", accountNumber: "2", accountType: "S",
      status: "AWAITING_APPROVAL" as const, createdById: requester().id, requestedById: requester().id, disbursedById: disburser().id,
    })
    await refused(db.disbursementPayout.create({ data: attempt(2) }), /not active or whose reversal is open/)
    await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: (req as { reversalId: string }).reversalId, approve: true, note: "Confirmed", actor: checker() })
    await refused(db.disbursementPayout.create({ data: attempt(2) }), /not active or whose reversal is open/)
  })

  it("never leaves an attempt that can pay on a CANCELLED loan when a retry races a reversal", async () => {
    for (let i = 0; i < 6; i++) {
      const loan = await failedLoan()
      await Promise.allSettled([requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() }), reverse(loan.loanId)])
      const after = await db.loan.findUniqueOrThrow({ where: { id: loan.loanId }, select: { status: true } })
      const live = await db.disbursementPayout.count({ where: { loanId: loan.loanId, status: { notIn: ["FAILED", "RETURNED", "CANCELLED"] } } })
      expect(after.status === "CANCELLED" && live > 0, `loan ${i}: CANCELLED with ${live} live attempt(s)`).toBe(false)
    }
  })

  it("answers the loser of two concurrent retry requests with a 409, not a raw error", async () => {
    const loan = await failedLoan()
    const outs = await Promise.all([1, 2].map(() => requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })))
    expect(outs.filter((o) => o.ok)).toHaveLength(1)
    expect(outs.find((o) => !o.ok)).toMatchObject({ ok: false, status: 409 })
  })

  it("records a provider reporting PAID after a failure, audits it, and blocks retry and reversal until a second person resolves it", async () => {
    const loan = await failedLoan()
    const payout = await db.disbursementPayout.findUniqueOrThrow({ where: { id: loan.payoutId } })
    const out = await applyProviderState(prisma, { tenantId: tenant.tenantId, payout, state: "PAID", source: "webhook", actor: { id: null, email: "webhook:simulated" } })
    expect(out).toMatchObject({ status: "FAILED", changed: false, conflict: true })
    expect(await db.disbursementPayout.findUniqueOrThrow({ where: { id: loan.payoutId } })).toMatchObject({ status: "FAILED", providerConflictState: "PAID" })
    expect(await db.auditLog.count({ where: { entityId: loan.payoutId, action: "PAYOUT_PROVIDER_CONFLICT" } })).toBe(1)
    expect(await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })).toMatchObject({ ok: false, status: 409 })
    expect(await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says it never arrived", actor: requester() })).toMatchObject({ ok: false, status: 409 })
    // The disburser may not resolve it; a second LOAN_ADMIN may.
    expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: loan.payoutId, actor: disburser(), request: { action: "resolve_conflict", outcome: "not_paid", note: "Bank statement shows nothing left" } })).toMatchObject({ ok: false, status: 403 })
    expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: loan.payoutId, actor: checker(), request: { action: "resolve_conflict", outcome: "not_paid", note: "Bank statement shows nothing left" } })).toMatchObject({ ok: true })
    expect(await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })).toMatchObject({ ok: true })
  })

  it("asks a rail that can be asked before reversing, and refuses when it says the money went", async () => {
    // Suffix 5555: the simulated provider's status query reports PAID.
    const loan = await failedLoan("5555")
    const out = await reverse(loan.loanId)
    expect(out).toMatchObject({ ok: false, status: 409 })
    expect(await db.disbursementPayout.findUniqueOrThrow({ where: { id: loan.payoutId } })).toMatchObject({ providerConflictState: "PAID" })
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).status).toBe("ACTIVE")
  })

  it("refuses settlement by the attempt's approver, in code and in the database", async () => {
    const loan = await failedLoan()
    const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
    const retryId = (req as { payoutId: string }).payoutId
    await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: checker() })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date() } })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "NEEDS_REVIEW" } })
    expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: retryId, actor: checker(), request: { action: "confirm_paid", note: "I approved it, and it paid" } })).toMatchObject({ ok: false, status: 403 })
    await refused(db.disbursementPayout.update({ where: { id: retryId }, data: { status: "PAID", paidAt: new Date(), resolvedById: checker().id, resolutionNote: "self" } }), /approver cannot settle/)
  })
})
