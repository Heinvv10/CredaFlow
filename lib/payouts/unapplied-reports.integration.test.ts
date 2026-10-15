/**
 * Real-Postgres proof for the PR #89 round 3 scan on provider reports not
 * applied, and on the reopen rules:
 *  (1) every report not applied is kept in PayoutUnappliedReport, tenant
 *      scoped, listed with a true count however old, and stays listed until
 *      a person acknowledges it (once, audited, DB-guarded);
 *  (2) a new event never lowers the stored state (PAID, PAID_THEN_RETURNED)
 *      and leaves the conflict fields consistent; a report on money already
 *      in a recovery case is listed with its reason.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/unapplied-reports.integration.test.ts
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
import { decideDisbursementReversal, requestDisbursementReversal } from "./reversal"
import type { ProviderPayoutState } from "./types"
import { acknowledgeUnappliedReport, loadUnappliedReports } from "./unapplied-reports"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
let other: ChargesTenant
const user = (suffix: string) => ({ id: `${tenant.userId}${suffix}`, email: `${tenant.userId}${suffix}@test.invalid` })
const resolver = () => user("-res")

async function refused(work: Promise<unknown>, message: RegExp) {
  const error = await work.then(() => null, (e: unknown) => e)
  expect(error, "expected a refusal").not.toBeNull()
  expect(String((error as Error).message)).toMatch(message)
}
const row = (id: string) => db.disbursementPayout.findUniqueOrThrow({ where: { id } })
const report = async (payoutId: string, state: ProviderPayoutState, event: { id: string | null; at: Date | null }) =>
  applyProviderState(prisma, { tenantId: tenant.tenantId, payout: await row(payoutId), state, source: "webhook", actor: { id: null, email: "webhook:simulated" }, event })
const resolveAs = async (payoutId: string, outcome: "not_paid" | "recovery") => {
  const r = await row(payoutId)
  return resolvePayout(prisma, {
    tenantId: tenant.tenantId, payoutId, actor: resolver(),
    request: { action: "resolve_conflict", outcome, note: "Checked the bank statement", seen: { state: r.providerConflictState!, at: r.providerConflictAt! } },
  })
}
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)
const listed = async (payoutId: string) => (await loadUnappliedReports(prisma, tenant.tenantId, { page: 1, pageSize: 500 })).items.filter((r) => r.payoutId === payoutId)

suite.sequential("provider reports not applied, and reopen consistency (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    other = await createChargesTenant(db, false)
    for (const t of [tenant, other]) await db.tenantConfig.update({ where: { tenantId: t.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    await db.user.create({ data: { id: resolver().id, tenantId: tenant.tenantId, email: resolver().email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("(1) keeps every report not applied listed with a true count, however old, until a person acknowledges it", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PROCESSING", { id: "S1", at: null })
    await report(loan.payoutId, "PAID", { id: "P1", at: null })
    await report(loan.payoutId, "RETURNED", { id: "R0", at: minutesAgo(30) })
    const entries = await listed(loan.payoutId)
    expect(entries.map((e) => e.outcome).sort()).toEqual(["dropped", "stale"])
    // A year old is still listed: no date window.
    await db.payoutUnappliedReport.create({ data: { tenantId: tenant.tenantId, payoutId: loan.payoutId, reported: "PAID", outcome: "dropped", reason: "weaker_or_older", source: "webhook", createdAt: new Date(Date.now() - 365 * 86_400_000) } })
    expect((await listed(loan.payoutId)).map((e) => e.outcome).sort()).toEqual(["dropped", "dropped", "stale"])
    const page = await loadUnappliedReports(prisma, tenant.tenantId, { page: 1, pageSize: 1 })
    expect(page.items).toHaveLength(1)
    expect(page.total).toBeGreaterThanOrEqual(2)
    // Acknowledged once, audited, then off the list.
    const first = entries[0]
    const ack = () => acknowledgeUnappliedReport(prisma, { tenantId: tenant.tenantId, id: first.id, note: "Checked with the provider", actor: resolver() })
    expect(await ack()).toEqual({ ok: true })
    expect(await ack()).toMatchObject({ ok: false, status: 409 })
    expect(await db.auditLog.count({ where: { entityId: first.id, action: "PAYOUT_PROVIDER_REPORT_ACKNOWLEDGED" } })).toBe(1)
    expect((await listed(loan.payoutId)).map((e) => e.id)).not.toContain(first.id)
    // Another tenant neither sees it nor can acknowledge it.
    expect((await loadUnappliedReports(prisma, other.tenantId, { page: 1, pageSize: 500 })).items.some((e) => e.payoutId === loan.payoutId)).toBe(false)
    const second = (await listed(loan.payoutId))[0]
    expect(await acknowledgeUnappliedReport(prisma, { tenantId: other.tenantId, id: second.id, note: "Not mine to see", actor: resolver() })).toMatchObject({ ok: false, status: 404 })
  })

  it("(1) the database keeps an entry as recorded and acknowledges it once, with a note", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PROCESSING", { id: "S1", at: null })
    const [entry] = await listed(loan.payoutId)
    await refused(db.payoutUnappliedReport.delete({ where: { id: entry.id } }), /never deleted/)
    await refused(db.payoutUnappliedReport.update({ where: { id: entry.id }, data: { reported: "PAID" } }), /kept as recorded/)
    await refused(db.payoutUnappliedReport.update({ where: { id: entry.id }, data: { acknowledgedAt: new Date(), acknowledgedById: resolver().id } }), /with a note/)
  })

  it("(2) a new, older RETURNED reopens a resolved PAID without lowering it, and its time never moves the state's time back", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "P1", at: minutesAgo(5) })
    const paid = await row(loan.payoutId)
    await resolveAs(loan.payoutId, "not_paid")
    expect(await report(loan.payoutId, "RETURNED", { id: "R1", at: minutesAgo(20) })).toMatchObject({ report: "reopened" })
    const after = await row(loan.payoutId)
    expect(after).toMatchObject({ providerConflictState: "PAID", conflictResolvedAt: null, providerConflictEventId: "R1" })
    expect(after.providerConflictEventAt!.getTime()).toBe(paid.providerConflictEventAt!.getTime())
    expect(after.providerConflictEventAt!.getTime()).toBeLessThanOrEqual(after.providerConflictAt!.getTime())
  })

  it("(2) the database refuses a reopen that lowers the stored state, and holds the conflict fields consistent", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "P1", at: minutesAgo(5) })
    await resolveAs(loan.payoutId, "not_paid")
    const clear = { conflictResolvedAt: null, conflictResolvedById: null, conflictResolutionNote: null }
    await refused(db.disbursementPayout.update({ where: { id: loan.payoutId }, data: { ...clear, providerConflictState: "RETURNED", providerConflictAt: new Date(), providerConflictEventId: "R9", providerConflictDetail: "lower" } }), /terms never change/)
    const checks = await db.$queryRawUnsafe<Array<{ def: string }>>(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'DisbursementPayout_conflict_consistency'`)
    expect(checks[0]?.def).toMatch(/providerConflictEventAt.*<=.*providerConflictAt/)
    expect(checks[0]?.def).toMatch(/conflictResolvedAt.*>=.*providerConflictAt/)
  })

  it("(2) lists a report on money already in a recovery case, with that reason, instead of reopening it", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    const requester = user("-req2")
    const checker = user("-chk2")
    for (const u of [requester, checker]) await db.user.upsert({ where: { id: u.id }, create: { id: u.id, tenantId: tenant.tenantId, email: u.email, password: "x", role: "LOAN_ADMIN" }, update: {} })
    const rev = await requestDisbursementReversal(prisma, { tenantId: tenant.tenantId, loanId: loan.loanId, reason: "The bank says the account is closed", actor: requester })
    await decideDisbursementReversal(prisma, { tenantId: tenant.tenantId, reversalId: (rev as { reversalId: string }).reversalId, approve: true, note: "Confirmed", actor: checker })
    await report(loan.payoutId, "PAID", { id: "P1", at: null })
    expect(await resolveAs(loan.payoutId, "recovery")).toMatchObject({ ok: true })
    expect(await report(loan.payoutId, "PAID", { id: "P2", at: null })).toMatchObject({ report: "dropped" })
    expect(await listed(loan.payoutId)).toEqual([expect.objectContaining({ outcome: "dropped", reason: "recovery_case", reported: "PAID" })])
  })
})
