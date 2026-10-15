/**
 * Real-Postgres proof for the scan on 20261015270000: the people excluded
 * from acknowledging a provider report not applied are the same in code and
 * in the database guard, computed from the rows: the disburser, the attempt's
 * creator and requester, its approver, whoever confirmed it paid, failed or
 * returned, every resolver of a conflict on it (a reopen clears the column,
 * so earlier ones come from the audit trail), and the recovery case's opener
 * and escalator. Each is refused in code (403) and by direct SQL.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/unapplied-ack-duties.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { prisma } from "@/lib/prisma"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { failedPayoutLoan } from "./payouts.integration-fixture"
import { escalateRecovery } from "./recovery"
import { applyProviderState, resolvePayout } from "./resolve"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"
import type { ProviderPayoutState } from "./types"
import { acknowledgeUnappliedReport, loadUnappliedReports } from "./unapplied-reports"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
type User = { id: string; email: string }
const user = (suffix: string): User => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const ROLES = ["-req", "-apr", "-conf", "-res1", "-res2", "-res3", "-esc", "-ret", "-clk"] as const

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}
const row = (id: string) => db.disbursementPayout.findUniqueOrThrow({ where: { id } })
let eventNo = 0
const report = async (payoutId: string, state: ProviderPayoutState) =>
  applyProviderState(prisma, { tenantId: tenant.tenantId, payout: await row(payoutId), state, source: "webhook", actor: { id: null, email: "webhook:simulated" }, event: { id: `EV${++eventNo}`, at: null } })
const resolveAs = async (payoutId: string, outcome: "not_paid" | "recovery", actor: User) => {
  const r = await row(payoutId)
  return resolvePayout(prisma, {
    tenantId: tenant.tenantId, payoutId, actor,
    request: { action: "resolve_conflict", outcome, note: "Checked the bank statement", seen: { state: r.providerConflictState!, at: r.providerConflictAt! } },
  })
}
const entryOf = async (payoutId: string) => (await loadUnappliedReports(prisma, tenant.tenantId, { page: 1, pageSize: 500 })).items.find((r) => r.payoutId === payoutId)!
const NOT_THEM = /neither made, approved or resolved/

async function refusedEverywhere(entryId: string, actor: User) {
  expect(await acknowledgeUnappliedReport(prisma, { tenantId: tenant.tenantId, id: entryId, note: "Checked with the provider", actor }), actor.id).toMatchObject({ ok: false, status: 403 })
  await refused(db.payoutUnappliedReport.update({ where: { id: entryId }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.id, acknowledgementNote: "by hand" } }), NOT_THEM)
}

suite.sequential("who may acknowledge a report not applied (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const s of ROLES) await db.user.create({ data: { id: user(s).id, tenantId: tenant.tenantId, email: user(s).email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("refuses the disburser, creator/requester, approver, confirmer, every conflict resolver and the recovery opener and escalator", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    // Attempt 2: requested, approved, sent, outcome unknown, confirmed failed.
    const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: user("-req") })
    const retryId = (req as { payoutId: string }).payoutId
    await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: user("-apr") })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date(), providerReference: `sim-disburse:${loan.applicationId}-1111` } })
    await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "NEEDS_REVIEW" } })
    expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: retryId, actor: user("-conf"), request: { action: "confirm_failed", note: "Provider report shows it failed" } })).toMatchObject({ ok: true })
    // A PAID report, resolved not paid by res1; the loan is reversed; a new PAID reopens it; res2 opens a recovery case; esc escalates.
    await report(retryId, "PAID")
    expect(await resolveAs(retryId, "not_paid", user("-res1"))).toMatchObject({ ok: true })
    const rev = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says the account is closed", actor: user("-req") })
    expect(await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: (rev as { reversalId: string }).reversalId, approve: true, note: "Confirmed", actor: user("-apr") })).toMatchObject({ ok: true })
    expect(await report(retryId, "PAID")).toMatchObject({ report: "reopened" })
    expect(await resolveAs(retryId, "recovery", user("-res2"))).toMatchObject({ ok: true })
    const c = await db.payoutRecoveryCase.findUniqueOrThrow({ where: { payoutId: retryId } })
    expect(await escalateRecovery(prisma, { tenantId: tenant.tenantId, caseId: c.id, note: "Recipient will not return it", actor: user("-esc") })).toMatchObject({ ok: true })
    // One more PAID: dropped (already a recovery case) and listed.
    expect(await report(retryId, "PAID")).toMatchObject({ report: "dropped" })
    const entry = await entryOf(retryId)
    for (const s of ["", "-req", "-apr", "-conf", "-res1", "-res2", "-esc"]) await refusedEverywhere(entry.id, user(s))
    expect(await acknowledgeUnappliedReport(prisma, { tenantId: tenant.tenantId, id: entry.id, note: "Checked with the provider", actor: user("-clk") })).toEqual({ ok: true })
  })

  it("refuses whoever confirmed the attempt returned", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""), "PAID")
    expect(await resolvePayout(prisma, { tenantId: tenant.tenantId, payoutId: loan.payoutId, actor: user("-ret"), request: { action: "confirm_returned", note: "Bank credited it back", returnedAt: new Date() } })).toMatchObject({ ok: true, status: "RETURNED" })
    await report(loan.payoutId, "PAID")
    const entry = await entryOf(loan.payoutId)
    await refusedEverywhere(entry.id, user("-ret"))
    expect(await acknowledgeUnappliedReport(prisma, { tenantId: tenant.tenantId, id: entry.id, note: "Checked with the provider", actor: user("-clk") })).toEqual({ ok: true })
  })

  it("refuses a conflict resolver recorded on the row even without an audit row (resolved by hand in the database)", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID")
    await db.disbursementPayout.update({ where: { id: loan.payoutId }, data: { conflictResolvedAt: new Date(), conflictResolvedById: user("-res3").id, conflictResolutionNote: "resolved by hand" } })
    await report(loan.payoutId, "PROCESSING")
    const entry = await entryOf(loan.payoutId)
    await refusedEverywhere(entry.id, user("-res3"))
  })
})
