/**
 * Real-Postgres proof against replayed provider reports (PR #89 round 3
 * scan, "fail-open / webhook replay"): a report carries the provider's event
 * id and event time; an exact duplicate is audited and changes nothing; a
 * report is ordered by the provider's event time (capped at receipt, which
 * is the database clock), so one not newer than a resolution never reopens it.
 *
 *   RUN_PAYOUTS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/payouts/conflict-replay.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/compliance/debit-mandate.server", () => ({
  findVerifiedBankStatementForMandate: vi.fn(async () => ({ ok: true, evidence: { documentId: "stmt", documentSha256: "x", verifiedAt: "x" } })),
}))

import { prisma } from "@/lib/prisma"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { failedPayoutLoan } from "./payouts.integration-fixture"
import { signSimulatedWebhook, simulatedPayouts } from "./providers/simulated"
import { applyProviderState, ingestNotification, resolvePayout } from "./resolve"
import type { ProviderPayoutState } from "./types"

const suite = process.env.RUN_PAYOUTS_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
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
const resolveNotPaid = async (payoutId: string) => {
  const r = await row(payoutId)
  return resolvePayout(prisma, {
    tenantId: tenant.tenantId, payoutId, actor: resolver(),
    request: { action: "resolve_conflict", outcome: "not_paid", note: "Bank statement shows nothing left", seen: { state: r.providerConflictState!, at: r.providerConflictAt! } },
  })
}
const outcomes = async (id: string) => (await db.auditLog.findMany({ where: { entityId: id, action: "PAYOUT_PROVIDER_CONFLICT" }, orderBy: { createdAt: "asc" } }))
  .map((a) => (a.newValue as { outcome: string }).outcome)
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000)

suite.sequential("replayed provider reports (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { payoutsEngineEnabled: true, payoutProvider: "simulated" } })
    await db.user.create({ data: { id: resolver().id, tenantId: tenant.tenantId, email: resolver().email, password: "x", role: "LOAN_ADMIN" } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("does not reopen on a replay of the PAID event a not-paid decision was made on; a new PAID event reopens", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    expect(await report(loan.payoutId, "PAID", { id: "E1", at: minutesAgo(5) })).toMatchObject({ report: "recorded" })
    expect(await resolveNotPaid(loan.payoutId)).toMatchObject({ ok: true })
    expect(await report(loan.payoutId, "PAID", { id: "E1", at: minutesAgo(5) })).toMatchObject({ report: "duplicate" })
    expect(await row(loan.payoutId)).toMatchObject({ conflictResolvedById: resolver().id })
    await new Promise((r) => setTimeout(r, 5))
    expect(await report(loan.payoutId, "PAID", { id: "E2", at: new Date() })).toMatchObject({ conflict: true, report: "reopened" })
    expect(await row(loan.payoutId)).toMatchObject({ conflictResolvedAt: null, providerConflictEventId: "E2" })
    expect(await outcomes(loan.payoutId)).toEqual(["recorded", "duplicate", "reopened"])
  })

  it("does not reopen on a new event whose provider time is not newer than the resolution", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "E1", at: minutesAgo(10) })
    await resolveNotPaid(loan.payoutId)
    expect(await report(loan.payoutId, "PAID", { id: "E0", at: minutesAgo(8) })).toMatchObject({ report: "dropped" })
    expect(await row(loan.payoutId)).toMatchObject({ conflictResolvedById: resolver().id, providerConflictEventId: "E1" })
  })

  it("caps a provider event time in the future at receipt", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "E9", at: new Date("2999-01-01T00:00:00Z") })
    const r = await row(loan.payoutId)
    expect(r.providerConflictEventAt!.getTime()).toBeLessThanOrEqual(r.providerConflictAt!.getTime())
  })

  it("the database refuses a reopen by a report not newer than the resolution", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "E1", at: minutesAgo(10) })
    await resolveNotPaid(loan.payoutId)
    const r = await row(loan.payoutId)
    await refused(db.disbursementPayout.update({
      where: { id: loan.payoutId },
      data: {
        conflictResolvedAt: null, conflictResolvedById: null, conflictResolutionNote: null,
        providerConflictAt: new Date(r.conflictResolvedAt!.getTime() + 1000), providerConflictEventAt: minutesAgo(9), providerConflictEventId: "E0", providerConflictDetail: "replayed",
      },
    }), /terms never change/)
  })

  it("dedupes a redelivered simulated webhook by its event id (the body's, else a hash of it)", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    vi.stubEnv("SIMULATED_PAYOUT_WEBHOOK_SECRET", "it-secret")
    try {
      const body = JSON.stringify({ idempotencyKey: (await row(loan.payoutId)).idempotencyKey, state: "PAID", occurredAt: minutesAgo(3).toISOString() })
      const ts = Math.floor(Date.now() / 1000)
      const headers = new Headers({ "x-simulated-timestamp": String(ts), "x-simulated-signature": signSimulatedWebhook(body, "it-secret", ts) })
      const deliver = () => ingestNotification(prisma, { tenantId: tenant.tenantId, providerId: "simulated", notification: simulatedPayouts.parseWebhook!({ rawBody: body, headers })! })
      expect(await deliver()).toMatchObject({ matched: true, report: "recorded" })
      expect(await deliver()).toMatchObject({ matched: true, report: "duplicate" })
      expect(await db.payoutProviderEvent.count({ where: { payoutId: loan.payoutId } })).toBe(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  // ── Clock skew between app nodes (breaker X6) ──

  it("reopens on a later PAID even when the node that resolved runs 60 s fast", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "S1", at: null })
    vi.useFakeTimers({ toFake: ["Date"] })
    try {
      vi.setSystemTime(new Date(Date.now() + 60_000))
      expect(await resolveNotPaid(loan.payoutId)).toMatchObject({ ok: true })
    } finally {
      vi.useRealTimers()
    }
    await new Promise((r) => setTimeout(r, 5))
    expect(await report(loan.payoutId, "PAID", { id: "S2", at: null })).toMatchObject({ conflict: true, report: "reopened" })
  })

  it("stamps resolution and receipt with the database clock, whatever time the app writes", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    await report(loan.payoutId, "PAID", { id: "S1", at: null })
    const skewed = new Date(Date.now() + 60_000)
    await db.disbursementPayout.update({ where: { id: loan.payoutId }, data: { conflictResolvedAt: skewed, conflictResolvedById: resolver().id, conflictResolutionNote: "resolved on a fast node" } })
    expect((await row(loan.payoutId)).conflictResolvedAt!.getTime()).toBeLessThan(skewed.getTime() - 30_000)
    await new Promise((r) => setTimeout(r, 5))
    expect(await report(loan.payoutId, "PAID", { id: "S2", at: null })).toMatchObject({ report: "reopened" })
  })

  it("audits a report the database refuses as rejected, and does not throw (a webhook must not fail on it)", async () => {
    const loan = await failedPayoutLoan(db, tenant, user(""))
    // A database refusal the code did not foresee, on this payout only.
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "itRefuseConflict"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."id" = '${loan.payoutId}' AND NEW."providerConflictState" IS NOT NULL THEN RAISE EXCEPTION 'Payout guard: refused for the test'; END IF; RETURN NEW; END; $$`)
    await db.$executeRawUnsafe(`CREATE TRIGGER "itRefuseConflict" BEFORE UPDATE ON "DisbursementPayout" FOR EACH ROW EXECUTE FUNCTION "itRefuseConflict"()`)
    try {
      expect(await report(loan.payoutId, "PAID", { id: "R1", at: null })).toMatchObject({ report: "rejected" })
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER "itRefuseConflict" ON "DisbursementPayout"`)
      await db.$executeRawUnsafe(`DROP FUNCTION "itRefuseConflict"()`)
    }
    const audit = await db.auditLog.findFirst({ where: { entityId: loan.payoutId, action: "PAYOUT_PROVIDER_REPORT_REJECTED" } })
    expect(audit?.newValue).toMatchObject({ reported: "PAID", eventId: "R1", reason: expect.stringContaining("refused for the test") })
    // Not marked as seen: a redelivery is processed again.
    expect(await report(loan.payoutId, "PAID", { id: "R1", at: null })).toMatchObject({ report: "recorded" })
  })
})
