/**
 * Real-Postgres proof of the remedies for a payout that failed or came back:
 * a retry is a new, approved attempt (never two in flight, never approved by
 * the requester or the disburser), and a reversal cancels the loan only with a
 * second person's approval and only while no money can have reached the
 * borrower.
 *
 * The verified-bank-statement lookup is stubbed (it reads stored PDF bytes);
 * the AVS check, the payout and reversal guards and the loan are real.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/retry-reversal.integration.test.ts
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
import { dispatchPayout } from "./dispatch"
import { registerPayoutProvider } from "./registry"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"
import { simulatedPayouts } from "./providers/simulated"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
const user = (suffix: string) => ({ id: `${tenant.userId}${suffix}`, email: `${suffix || "disburser"}@test.invalid` })
const disburser = () => user("")
const requester = () => user("-req")
const checker = () => user("-chk")
const BANK = { bankName: "FNB", bankBranchCode: "250655", bankAccountNumber: "62000005678", accountType: "SAVINGS" as const }
const send = vi.fn(async () => ({ kind: "accepted" as const, state: "SUBMITTED" as const, providerReference: "retry-ref" }))

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}

/** A loan disbursed through the engine whose first payout FAILED, with a fresh passing AVS of the current account. */
async function failedPayoutLoan() {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true, clientId: true } })
  const client = await db.client.update({ where: { id: loan.clientId! }, data: BANK })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "it-retry",
    amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser(), avs: { avsCheckId: "it", simulated: false },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed", resolvedAt: new Date() } })
  await new Promise((r) => setTimeout(r, 5))
  await db.avsCheck.create({
    data: {
      tenantId: tenant.tenantId, clientId: client.id, applicationId: loan.applicationId, provider: "netcash",
      subjectFingerprint: avsSubjectFingerprint(client), accountHolder: "Charge Test", bankName: BANK.bankName,
      branchCode: BANK.bankBranchCode, accountNumber: BANK.bankAccountNumber, accountType: BANK.accountType,
      passed: true, checks: { accountActive: true },
    },
  })
  return { loanId: ids.loanId, applicationId: loan.applicationId, firstPayoutId: id }
}

suite.sequential("payout retry and disbursement reversal (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "it-retry" } })
    for (const u of [requester(), checker()]) {
      await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: `${u.id}@test.invalid`, password: "x", role: "LOAN_ADMIN" } })
    }
    registerPayoutProvider({
      id: "it-retry", displayName: "IT retry", capabilities: { implemented: true, statusQuery: false, webhooks: false }, simulation: () => null,
      initiatePayout: send, getPayoutStatus: async () => ({ kind: "unsupported" }),
    })
  })
  afterAll(async () => {
    registerPayoutProvider(simulatedPayouts)
    await db.$disconnect()
  })

  it("retries a failed payout as a new, second-person-approved attempt to the current verified account", async () => {
    const loan = await failedPayoutLoan()
    const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
    expect(req).toMatchObject({ ok: true, status: "AWAITING_APPROVAL" })
    const retryId = (req as { payoutId: string }).payoutId
    const retry = await db.disbursementPayout.findUniqueOrThrow({ where: { id: retryId } })
    expect(retry).toMatchObject({ attempt: 2, idempotencyKey: `disburse:${loan.applicationId}:2`, accountNumber: BANK.bankAccountNumber, disbursedById: disburser().id, retryOfId: loan.firstPayoutId })

    // One open attempt per application: in code and in the database.
    expect(await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })).toMatchObject({ ok: false, status: 409 })
    await refused(db.disbursementPayout.create({ data: {
      tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: loan.loanId, attempt: 3, retryOfId: loan.firstPayoutId,
      provider: "it-retry", idempotencyKey: `disburse:${loan.applicationId}:3`, amountCents: 200_000, reference: "R",
      accountHolder: "A", bankName: "B", branchCode: "1", accountNumber: "2", accountType: "S",
      status: "AWAITING_APPROVAL", createdById: requester().id, requestedById: requester().id, disbursedById: disburser().id,
    } }), /follows a failed, returned or cancelled attempt|unique/i)

    // Neither the requester nor the disburser approves it.
    for (const who of [requester(), disburser()]) {
      expect(await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: who })).toMatchObject({ ok: false, status: 403 })
    }
    await refused(db.disbursementPayout.update({ where: { id: retryId }, data: { status: "PENDING", approvedById: requester().id, approvedAt: new Date() } }), /approved by a second person/)

    send.mockClear()
    expect(await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "approved", actor: checker() })).toMatchObject({ ok: true, status: "PENDING" })
    expect(await dispatchPayout(prisma, { tenantId: tenant.tenantId, payoutId: retryId, actor: checker() })).toMatchObject({ kind: "sent", status: "SUBMITTED" })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: `disburse:${loan.applicationId}:2`, beneficiary: expect.objectContaining({ accountNumber: BANK.bankAccountNumber }) }))
    const audits = await db.auditLog.findMany({ where: { entityId: retryId, action: { in: ["PAYOUT_RETRY_REQUESTED", "PAYOUT_RETRY_DECIDED", "PAYOUT_ACTION_REFUSED"] } } })
    expect(audits.map((a) => a.action).sort()).toEqual(["PAYOUT_ACTION_REFUSED", "PAYOUT_ACTION_REFUSED", "PAYOUT_RETRY_DECIDED", "PAYOUT_RETRY_REQUESTED"])
  })

  it("refuses a retry whose AVS predates the failure", async () => {
    const loan = await failedPayoutLoan()
    await db.$executeRaw`UPDATE "AvsCheck" SET "createdAt" = '2020-01-01' WHERE "applicationId" = ${loan.applicationId}`
    expect(await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("predates") })
  })

  it("reverses a disbursement only with a second person's approval and no live receipt, and cancels the loan", async () => {
    const loan = await failedPayoutLoan()
    const req = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "Account closed; the bank returned nothing", actor: requester() })
    expect(req).toMatchObject({ ok: true, status: "REQUESTED" })
    const reversalId = (req as { reversalId: string }).reversalId
    for (const who of [requester(), disburser()]) {
      expect(await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId, approve: true, note: "never paid", actor: who })).toMatchObject({ ok: false, status: 403 })
    }
    await refused(db.disbursementReversal.update({ where: { id: reversalId }, data: { status: "APPROVED", decidedById: requester().id, decidedAt: new Date() } }), /second person/)

    const pay = await db.payment.create({ data: { tenantId: tenant.tenantId, loanId: loan.loanId, amount: 100 } })
    expect(await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId, approve: true, note: "never paid", actor: checker() })).toMatchObject({ ok: false, status: 409 })
    await refused(db.disbursementReversal.update({ where: { id: reversalId }, data: { status: "APPROVED", decidedById: checker().id, decidedAt: new Date() } }), /live receipt/)
    await db.payment.update({ where: { id: pay.id }, data: { reversed: true, reversedAt: new Date(), reversalReason: "test" } })

    expect(await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId, approve: true, note: "Bank confirms the money never arrived", actor: checker() })).toMatchObject({ ok: true, status: "APPROVED" })
    expect(await db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).toMatchObject({ status: "CANCELLED", outstandingPrincipal: 0, arrearsAmount: 0, daysInArrears: 0, totalRepayable: 216_900 })
    expect(await db.auditLog.count({ where: { entityId: loan.loanId, action: "LOAN_CANCELLED" } })).toBe(1)
    await refused(db.disbursementReversal.update({ where: { id: reversalId }, data: { decisionNote: "edit" } }), /decided once/)
  })

  it("refuses to reverse a loan whose payout was paid", async () => {
    const loan = await failedPayoutLoan()
    const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
    const retryId = (req as { payoutId: string }).payoutId
    await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: checker() })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date() } })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "PAID", paidAt: new Date() } })
    expect(await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "Wrongly think it failed", actor: requester() })).toMatchObject({ ok: false, status: 409 })
    await refused(db.disbursementReversal.create({ data: { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "x", requestedById: requester().id } }), /every payout attempt failed/)
  })
})
