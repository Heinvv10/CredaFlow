/**
 * Real-Postgres proof for the PR #89 round 3 scan on acknowledging a provider
 * report not applied: nobody who disbursed the loan, created or approved the
 * attempt, or resolved its conflict acknowledges it (code 403, audited; the
 * database repeats it), and acknowledging only clears the list entry — any
 * real block on retry, reversal or send stays until the conflict is resolved.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/unapplied-ack.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { prisma } from "@/lib/prisma"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { failedPayoutLoan } from "./payouts.integration-fixture"
import { applyProviderState, resolvePayout } from "./resolve"
import { decidePayoutRetry, requestPayoutRetry } from "./retry"
import { requestDisbursementReversal } from "./reversal"
import type { ProviderPayoutState } from "./types"
import { acknowledgeUnappliedReport, loadUnappliedReports } from "./unapplied-reports"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
type User = { id: string; email: string }
const user = (suffix: string): User => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const disburser = () => user("")
const requester = () => user("-req") // creates attempt 2
const approver = () => user("-apr") // approves attempt 2
const resolver = () => user("-res") // resolves the conflict
const clerk = () => user("-clk")

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}
const row = (id: string) => db.disbursementPayout.findUniqueOrThrow({ where: { id } })
const report = async (payoutId: string, state: ProviderPayoutState, event: { id: string | null; at: Date | null }) =>
  applyProviderState(prisma, { tenantId: tenant.tenantId, payout: await row(payoutId), state, source: "webhook", actor: { id: null, email: "webhook:simulated" }, event })
const entriesOf = async (payoutId: string) => (await loadUnappliedReports(prisma, tenant.tenantId, { page: 1, pageSize: 500 })).items.filter((r) => r.payoutId === payoutId)
const ack = (id: string, actor: User) => acknowledgeUnappliedReport(prisma, { tenantId: tenant.tenantId, id, note: "Checked with the provider", actor })
const dbAck = (id: string, actor: User) => db.payoutUnappliedReport.update({ where: { id }, data: { acknowledgedAt: new Date(), acknowledgedById: actor.id, acknowledgementNote: "by hand" } })

/** Attempt 2 (created by requester, approved by approver) FAILED, with a resolved PAID conflict and a stale report listed. */
async function listedOnRetry() {
  const loan = await failedPayoutLoan(db, tenant, disburser())
  const req = await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })
  const retryId = (req as { payoutId: string }).payoutId
  expect(await decidePayoutRetry(prisma, { tenantId: tenant.tenantId, payoutId: retryId, approve: true, note: "ok", actor: approver() })).toMatchObject({ ok: true })
  await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "SUBMITTING", submittedAt: new Date() } })
  await db.disbursementPayout.update({ where: { id: retryId }, data: { status: "FAILED" } })
  await report(retryId, "PAID", { id: "P1", at: null })
  const r = await row(retryId)
  expect(await resolvePayout(prisma, {
    tenantId: tenant.tenantId, payoutId: retryId, actor: resolver(),
    request: { action: "resolve_conflict", outcome: "not_paid", note: "Bank statement shows nothing left", seen: { state: r.providerConflictState!, at: r.providerConflictAt! } },
  })).toMatchObject({ ok: true })
  await report(retryId, "PROCESSING", { id: "S1", at: null })
  const [entry] = await entriesOf(retryId)
  return { ...loan, retryId, entryId: entry.id }
}

suite.sequential("acknowledging a report not applied (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    for (const u of [requester(), approver(), resolver(), clerk()]) await db.user.create({ data: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  for (const [who, actor] of [["the disburser", disburser], ["the attempt's creator", requester], ["the attempt's approver", approver], ["the conflict's resolver", resolver]] as const) {
    it(`refuses ${who}, in code (audited) and in the database`, async () => {
      const loan = await listedOnRetry()
      expect(await ack(loan.entryId, actor())).toMatchObject({ ok: false, status: 403 })
      expect(await db.auditLog.count({ where: { entityId: loan.entryId, action: "PAYOUT_ACTION_REFUSED" } })).toBe(1)
      await refused(dbAck(loan.entryId, actor()), /made, approved or resolved/)
      expect((await entriesOf(loan.retryId)).map((e) => e.id)).toContain(loan.entryId)
      expect(await ack(loan.entryId, clerk())).toEqual({ ok: true })
    })
  }

  it("clears only the list entry: a dropped PAID's real block on retry and reversal stays", async () => {
    const loan = await failedPayoutLoan(db, tenant, disburser())
    await report(loan.payoutId, "PAID", { id: "P1", at: null })
    expect(await report(loan.payoutId, "RETURNED", { id: "R0", at: new Date(Date.now() - 3_600_000) })).toMatchObject({ report: "dropped" })
    const [entry] = await entriesOf(loan.payoutId)
    expect(await ack(entry.id, clerk())).toEqual({ ok: true })
    expect(await row(loan.payoutId)).toMatchObject({ providerConflictState: "PAID", conflictResolvedAt: null })
    expect(await requestPayoutRetry(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, actor: requester() })).toMatchObject({ ok: false, status: 409 })
    expect(await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says it never arrived", actor: requester() })).toMatchObject({ ok: false, status: 409 })
  })
})
