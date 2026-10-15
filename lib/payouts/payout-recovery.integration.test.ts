/**
 * Real-Postgres proof for PR #89 round 3: after a loan's disbursement is
 * reversed,
 *  - a provider's late PAID report is never resolved as paid (code and
 *    database) and the loan is never reinstated; the money becomes an
 *    audited recovery case that is recorded recovered or escalated by someone
 *    who neither made nor approved the payout, and the accounting export
 *    carries it in payout clearing until it is recovered;
 *  - the by-hand debit-order cancellation is a task until acknowledged, once.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/payout-recovery.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { prisma } from "@/lib/prisma"
import { loadSourceLoans } from "@/lib/accounting/store"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createDisbursementPayout } from "./disbursement"
import { closeRecoveryUnrecoverable, escalateRecovery, recordRecoveredFunds } from "./recovery"
import { applyProviderState, resolvePayout } from "./resolve"
import { acknowledgeDebitOrderCancelled, decideDisbursementReversal, requestDisbursementReversal } from "./reversal"
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

/** An engine-disbursed loan whose only payout (simulated, suffix 1111: the rail says FAILED) FAILED, then reversed. */
async function reversedLoan() {
  const ids = await createChargesLoan(db, tenant)
  const loan = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true, reference: true } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: loan.applicationId, loanId: ids.loanId, providerId: "simulated",
    amountCents: 200_000, reference: loan.reference,
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser(), avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-1111` } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED", failureReason: "account closed" } })
  const req = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: ids.loanId, reason: "The bank says the account is closed", actor: requester() })
  const decided = await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: (req as { reversalId: string }).reversalId, approve: true, note: "Confirmed with the bank", actor: checker() })
  expect(decided).toMatchObject({ ok: true, status: "APPROVED" })
  return { loanId: ids.loanId, payoutId: id, reversalId: (req as { reversalId: string }).reversalId }
}
const reportPaid = async (payoutId: string) => applyProviderState(prisma, {
  tenantId: tenant.tenantId, payout: await db.disbursementPayout.findUniqueOrThrow({ where: { id: payoutId } }), state: "PAID", source: "webhook", actor: { id: null, email: "webhook:simulated" },
})
const resolve = (payoutId: string, outcome: "paid" | "recovery", actor = resolver(), paidAt: Date | null = null) =>
  resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId, actor, request: { action: "resolve_conflict", outcome, note: "Bank statement shows it left", paidAt } })

suite.sequential("money paid out on a reversed loan (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const u of [requester(), checker(), resolver()]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("refuses to resolve a late PAID report as paid on a reversed loan, in code and in the database, and never reinstates the loan", async () => {
    const loan = await reversedLoan()
    expect(await reportPaid(loan.payoutId)).toMatchObject({ conflict: true })
    expect(await resolve(loan.payoutId, "paid")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("is not resolved as paid and the loan is not reinstated") })
    await refused(db.disbursementPayout.update({
      where: { id: loan.payoutId },
      data: { status: "PAID", paidAt: new Date(), conflictResolvedAt: new Date(), conflictResolvedById: resolver().id, conflictResolutionNote: "x" },
    }), /recovery case, not a paid payout/)
    expect(await db.disbursementPayout.findUniqueOrThrow({ where: { id: loan.payoutId } })).toMatchObject({ status: "FAILED", conflictResolvedAt: null })
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).status).toBe("CANCELLED")
  })

  it("opens an audited recovery case instead, by a second person, for the attempt's amount and value date", async () => {
    const loan = await reversedLoan()
    await reportPaid(loan.payoutId)
    expect(await resolve(loan.payoutId, "recovery", disburser())).toMatchObject({ ok: false, status: 403 })
    const leftOn = new Date("2026-10-08T10:00:00+02:00")
    expect(await resolve(loan.payoutId, "recovery", resolver(), leftOn)).toMatchObject({ ok: true, status: "FAILED" })
    const opened = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: loan.payoutId } })
    expect(opened).toMatchObject({ status: "OPEN", amountCents: 200_000, paidAt: leftOn, loanId: loan.loanId, openedById: resolver().id })
    expect(await db.auditLog.count({ where: { entityId: opened.id, action: "PAYOUT_RECOVERY_OPENED" } })).toBe(1)
    expect(await db.disbursementPayout.findUniqueOrThrow({ where: { id: loan.payoutId } })).toMatchObject({ status: "FAILED", conflictResolvedById: resolver().id })
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).status).toBe("CANCELLED")
    // The loan page sees it; the accounting export carries it in clearing.
    const view = await loadPayoutView(tenant.tenantId, loan.loanId, "CANCELLED")
    expect(view?.recoveries).toEqual([expect.objectContaining({ id: opened.id, status: "OPEN", amountCents: 200_000 })])
    const sources = await loadSourceLoans(prisma, tenant.tenantId, new Date())
    expect(sources.find((l) => l.id === loan.loanId)?.recoveries).toEqual([{ id: opened.id, attempt: 1, amountCents: 200_000, paidAt: leftOn, recoveredAt: null, unrecoverableAt: null }])
    // The database refuses a case the resolution did not open.
    await refused(db.payoutRecoveryCase.create({ data: { tenantId: tenant.tenantId, loanId: loan.loanId, payoutId: loan.payoutId, amountCents: 200_000, paidAt: leftOn, openedById: resolver().id, openNote: "again" } }), /Unique constraint|payoutId/)
  })

  it("refuses a recovery case on a loan that was not reversed, in code and in the database", async () => {
    const ids = await createChargesLoan(db, tenant)
    const app = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true } })
    const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
      tenantId: tenant.tenantId, applicationId: app.applicationId, loanId: ids.loanId, providerId: "simulated", amountCents: 200_000, reference: "R",
      beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
      user: disburser(), avs: { avsCheckId: "it", simulated: true },
    }))
    await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
    await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED" } })
    await reportPaid(id)
    expect(await resolve(id, "recovery")).toMatchObject({ ok: false, status: 409, error: expect.stringContaining("this loan was not reversed") })
    await db.disbursementPayout.update({ where: { id }, data: { conflictResolvedAt: new Date(), conflictResolvedById: resolver().id, conflictResolutionNote: "not paid" } })
    await refused(db.payoutRecoveryCase.create({ data: { tenantId: tenant.tenantId, loanId: ids.loanId, payoutId: id, amountCents: 200_000, paidAt: new Date(), openedById: resolver().id, openNote: "not reversed" } }), /Recovery guard: a case opens only/)
  })

  it("escalates, then records the funds recovered: once, in order, never by the payout's makers", async () => {
    const loan = await reversedLoan()
    await reportPaid(loan.payoutId)
    await resolve(loan.payoutId, "recovery", resolver(), new Date("2026-10-08T10:00:00+02:00"))
    const c = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: loan.payoutId } })
    const escalate = (actor: ReturnType<typeof user>) => escalateRecovery(prisma, { tenantId: tenant.tenantId, caseId: c.id, note: "Recipient bank will not return it", actor })
    const recover = (actor: ReturnType<typeof user>, recoveredAt: Date, amountCents = 200_000) => recordRecoveredFunds(prisma, { tenantId: tenant.tenantId, caseId: c.id, recoveredAt, amountCents, note: "Recalled by the bank", reference: "RCL-1", actor })
    expect(await escalate(disburser())).toMatchObject({ ok: false, status: 403 })
    expect(await escalate(checker())).toMatchObject({ ok: true, status: "ESCALATED" })
    expect(await escalate(checker())).toMatchObject({ ok: false, status: 409 })
    expect(await recover(requester(), new Date("2026-10-01T10:00:00+02:00"))).toMatchObject({ ok: false, status: 422 })
    const back = new Date("2026-10-20T10:00:00+02:00")
    // Only the full amount: a part is escalated, not recorded.
    expect(await recover(requester(), back, 150_000)).toMatchObject({ ok: false, status: 422, error: expect.stringContaining("escalate") })
    expect(await recover(requester(), back)).toMatchObject({ ok: true, status: "RECOVERED" })
    expect(await db.payoutRecoveryCase.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ recoveredAmountCents: 200_000 })
    expect(await recover(requester(), back)).toMatchObject({ ok: false, status: 409 })
    expect(await db.auditLog.count({ where: { entityId: c.id, action: { in: ["PAYOUT_RECOVERY_ESCALATED", "PAYOUT_RECOVERY_RECORDED"] } } })).toBe(2)
    expect((await loadSourceLoans(prisma, tenant.tenantId, new Date())).find((l) => l.id === loan.loanId)?.recoveries[0]).toMatchObject({ recoveredAt: back })
    // The database: a recovered case is closed, never deleted; its opening facts never change.
    await refused(db.payoutRecoveryCase.update({ where: { id: c.id }, data: { status: "ESCALATED" } }), /recovered case is closed/)
    await refused(db.payoutRecoveryCase.delete({ where: { id: c.id } }), /never deleted/)
    expect((await db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).status).toBe("CANCELLED")
  })

  it("refuses, in the database, a recovery step by the disburser or out of order", async () => {
    const loan = await reversedLoan()
    await reportPaid(loan.payoutId)
    await resolve(loan.payoutId, "recovery")
    const c = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: loan.payoutId } })
    await refused(db.payoutRecoveryCase.update({ where: { id: c.id }, data: { status: "RECOVERED", recoveredAt: new Date(), recoveredById: disburser().id, recoveryNote: "self-cleared", recoveredAmountCents: 200_000 } }), /other than the people who made or approved/)
    await refused(db.payoutRecoveryCase.update({ where: { id: c.id }, data: { amountCents: 1 } }), /opening facts|opened on never change/)
    await refused(db.payoutRecoveryCase.update({ where: { id: c.id }, data: { status: "OPEN", escalationNote: "x" } }), /OPEN -> ESCALATED/)
    await refused(db.payoutRecoveryCase.update({ where: { id: c.id }, data: { status: "RECOVERED", recoveredAt: new Date(), recoveredById: checker().id, recoveryNote: "only part came back", recoveredAmountCents: 150_000 } }), /full amount/)
  })

  it("closes a case as unrecoverable: a second person, audited, final, and written off to bad debts", async () => {
    const loan = await reversedLoan()
    await reportPaid(loan.payoutId)
    await resolve(loan.payoutId, "recovery")
    const c = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: loan.payoutId } })
    const close = (actor: ReturnType<typeof user>) => closeRecoveryUnrecoverable(prisma, { tenantId: tenant.tenantId, caseId: c.id, note: "Recipient account closed; bank cannot recall", actor })
    expect(await close(disburser())).toMatchObject({ ok: false, status: 403 })
    expect(await close(checker())).toMatchObject({ ok: true, status: "UNRECOVERABLE" })
    expect(await close(checker())).toMatchObject({ ok: false, status: 409 })
    expect(await recordRecoveredFunds(prisma, { tenantId: tenant.tenantId, caseId: c.id, recoveredAt: new Date(), amountCents: 200_000, note: "came back after all", reference: null, actor: checker() })).toMatchObject({ ok: false, status: 409, error: "This case is closed as unrecoverable" })
    expect(await db.auditLog.count({ where: { entityId: c.id, action: "PAYOUT_RECOVERY_UNRECOVERABLE" } })).toBe(1)
    const closed = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { id: c.id } })
    expect(closed).toMatchObject({ status: "UNRECOVERABLE", unrecoverableById: checker().id })
    expect((await loadSourceLoans(prisma, tenant.tenantId, new Date())).find((l) => l.id === loan.loanId)?.recoveries[0]).toMatchObject({ unrecoverableAt: closed.unrecoverableAt, recoveredAt: null })
    // The database: final, and never by the payout's makers.
    await refused(db.payoutRecoveryCase.update({ where: { id: c.id }, data: { status: "RECOVERED", recoveredAt: new Date(), recoveredById: checker().id, recoveryNote: "x x x x x", recoveredAmountCents: 200_000 } }), /closed/)
    const other = await reversedLoan()
    await reportPaid(other.payoutId)
    await resolve(other.payoutId, "recovery")
    const o = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: other.payoutId } })
    await refused(db.payoutRecoveryCase.update({ where: { id: o.id }, data: { status: "UNRECOVERABLE", unrecoverableAt: new Date(), unrecoverableById: disburser().id, unrecoverableNote: "self-closed" } }), /other than the people who made or approved/)
  })

  it("keeps the debit-order cancellation as a task until acknowledged, once, and only after approval", async () => {
    const loan = await reversedLoan()
    expect((await loadPayoutView(tenant.tenantId, loan.loanId, "CANCELLED"))?.reversal).toMatchObject({ status: "APPROVED", debitOrderCancelAckAt: null })
    const ack = () => acknowledgeDebitOrderCancelled(prisma, { tenantId: tenant.tenantId, reversalId: loan.reversalId, note: "Cancelled with FNB, ref DO-1", actor: checker() })
    expect(await ack()).toEqual({ ok: true })
    expect(await ack()).toMatchObject({ ok: false, status: 409 })
    expect((await loadPayoutView(tenant.tenantId, loan.loanId, "CANCELLED"))?.reversal?.debitOrderCancelAckAt).not.toBeNull()
    expect(await db.auditLog.count({ where: { entityId: loan.reversalId, action: "DEBIT_ORDER_CANCEL_ACKNOWLEDGED" } })).toBe(1)
    // The database: set once; nothing else about a decided reversal changes.
    await refused(db.disbursementReversal.update({ where: { id: loan.reversalId }, data: { debitOrderCancelAckAt: new Date(), debitOrderCancelAckById: requester().id } }), /decided once/)
    await refused(db.disbursementReversal.update({ where: { id: loan.reversalId }, data: { decisionNote: "rewritten" } }), /decided once/)
    // Not before approval.
    const other = await reversedLoanRequestedOnly()
    await refused(db.disbursementReversal.update({ where: { id: other }, data: { debitOrderCancelAckAt: new Date(), debitOrderCancelAckById: checker().id } }), /only after the reversal is approved/)
  })
})

/** A reversal request on a failed loan, not yet decided. */
async function reversedLoanRequestedOnly(): Promise<string> {
  const ids = await createChargesLoan(db, tenant)
  const app = await db.loan.findUniqueOrThrow({ where: { id: ids.loanId }, select: { applicationId: true } })
  const { id } = await prisma.$transaction((tx) => createDisbursementPayout(tx, {
    tenantId: tenant.tenantId, applicationId: app.applicationId, loanId: ids.loanId, providerId: "simulated", amountCents: 200_000, reference: "R",
    beneficiary: { accountHolder: "Charge Test", bankName: "FNB", branchCode: "250655", accountNumber: "62000001111", accountType: "SAVINGS" },
    user: disburser(), avs: { avsCheckId: "it", simulated: true },
  }))
  await db.disbursementPayout.update({ where: { id }, data: { status: "SUBMITTING", submittedAt: new Date() } })
  await db.disbursementPayout.update({ where: { id }, data: { status: "FAILED" } })
  const req = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: ids.loanId, reason: "The bank says the account is closed", actor: requester() })
  return (req as { reversalId: string }).reversalId
}
