/**
 * Segregation of duties on a recovery case (PR #89 round 3 scan): nobody who
 * disbursed the loan, created or approved the attempt, or opened the case
 * acts on it; and the person who escalated it does not also close it
 * (recovered or unrecoverable). Refused in code (403, audited) and by the
 * database guard (guardPayoutRecoveryCase) for every transition.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/recovery-duties.integration.test.ts
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
import { closeRecoveryUnrecoverable, escalateRecovery, recordRecoveredFunds } from "./recovery"
import { applyProviderState, resolvePayout } from "./resolve"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
type User = { id: string; email: string }
const user = (suffix: string): User => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const disburser = () => user("")
const requester = () => user("-req") // creates attempt 2 and requests the reversal
const approver = () => user("-apr") // approves attempt 2 and decides the reversal
const opener = () => user("-opn") // resolves the late PAID report: opens the case
const escalator = () => user("-esc")
const closer = () => user("-cls")

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}
const NOT_THEM = /other than the people who made or approved this payout, opened the case/

/** A recovery case on attempt 2 (created by requester, approved by approver) of a reversed loan, opened by opener. */
async function caseOnApprovedRetry() {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true, clientId: true } })
  const client = await db.client.update({ where: { id: loan.clientId! }, data: { bankName: "FNB", bankBranchCode: "250655", bankAccountNumber: "62000001111", accountType: "SAVINGS" } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "simulated", amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser(), avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
  await new Promise((r) => setTimeout(r, 5))
  await db.avsCheck.create({ data: {
    tenantId: tenant.tenantId, clientId: client.id, applicationId: loan.applicationId, provider: "netcash", subjectFingerprint: avsSubjectFingerprint(client),
    accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS", passed: true, checks: {},
  } })
  const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: ids.loanId, actor: requester() })
  const retryId = (req as { payoutId: string }).payoutId
  expect(await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: approver() })).toMatchObject({ ok: true })
  await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-1111` } })
  await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "FAILED", failureReason: "account closed" } })
  const rev = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: ids.loanId, reason: "The bank says the account is closed", actor: requester() })
  expect(await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: (rev as { reversalId: string }).reversalId, approve: true, note: "Confirmed", actor: approver() })).toMatchObject({ ok: true, status: "APPROVED" })
  await applyProviderState(prisma, { tenantId: tenant.tenantId, payout: await db.disbursementPayout.findUniqueOrThrow({ where: { id: retryId } }), state: "PAID", source: "webhook", actor: { id: null, email: "webhook:simulated" } })
  expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: retryId, actor: opener(), request: { action: "resolve_conflict", outcome: "recovery", note: "Bank statement shows it left" } })).toMatchObject({ ok: true })
  return db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: retryId } })
}

const escalate = (caseId: string, actor: User) => escalateRecovery(prisma, { tenantId: tenant.tenantId, caseId, note: "Recipient will not return it", actor })
const recover = (caseId: string, actor: User) => recordRecoveredFunds(prisma, { tenantId: tenant.tenantId, caseId, recoveredAt: new Date(), amountCents: 200_000, note: "Recalled by the bank", reference: null, actor })
const close = (caseId: string, actor: User) => closeRecoveryUnrecoverable(prisma, { tenantId: tenant.tenantId, caseId, note: "Recipient account closed", actor })
const dbEscalate = (caseId: string, actor: User) => db.payoutRecoveryCase.update({ where: { id: caseId }, data: { status: "ESCALATED", escalatedAt: new Date(), escalatedById: actor.id, escalationNote: "by hand" } })
const dbRecover = (caseId: string, actor: User) => db.payoutRecoveryCase.update({ where: { id: caseId }, data: { status: "RECOVERED", recoveredAt: new Date(), recoveredById: actor.id, recoveryNote: "by hand", recoveredAmountCents: 200_000 } })
const dbClose = (caseId: string, actor: User) => db.payoutRecoveryCase.update({ where: { id: caseId }, data: { status: "UNRECOVERABLE", unrecoverableAt: new Date(), unrecoverableById: actor.id, unrecoverableNote: "by hand" } })

suite.sequential("recovery case: segregation of duties (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const u of [requester(), approver(), opener(), escalator(), closer()]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  for (const [who, actor] of [["the disburser", disburser], ["the attempt's creator", requester], ["the attempt's approver", approver], ["the case's opener", opener]] as const) {
    it(`refuses ${who} every step, in code and in the database`, async () => {
      const c = await caseOnApprovedRetry()
      expect(await escalate(c.id, actor())).toMatchObject({ ok: false, status: 403 })
      expect(await recover(c.id, actor())).toMatchObject({ ok: false, status: 403 })
      expect(await close(c.id, actor())).toMatchObject({ ok: false, status: 403 })
      await refused(dbEscalate(c.id, actor()), NOT_THEM)
      await refused(dbRecover(c.id, actor()), NOT_THEM)
      await refused(dbClose(c.id, actor()), NOT_THEM)
      expect((await db.payoutRecoveryCase.findUniqueOrThrow({ where: { id: c.id } })).status).toBe("OPEN")
    })
  }

  it("lets whoever escalated a case not also close it, either way, in code and in the database", async () => {
    const c = await caseOnApprovedRetry()
    expect(await escalate(c.id, escalator())).toMatchObject({ ok: true, status: "ESCALATED" })
    expect(await recover(c.id, escalator())).toMatchObject({ ok: false, status: 403 })
    expect(await close(c.id, escalator())).toMatchObject({ ok: false, status: 403 })
    await refused(dbRecover(c.id, escalator()), /escalated it does not also close it/)
    await refused(dbClose(c.id, escalator()), /escalated it does not also close it/)
    expect(await close(c.id, closer())).toMatchObject({ ok: true, status: "UNRECOVERABLE" })
  })

  it("records a recovery by a person outside the payout and the case", async () => {
    const c = await caseOnApprovedRetry()
    expect(await recover(c.id, closer())).toMatchObject({ ok: true, status: "RECOVERED" })
  })
})
