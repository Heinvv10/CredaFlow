/**
 * Real-Postgres proof of decision log retention (migration
 * 20261023200000_decision_record_retention): with no period nothing changes;
 * with one, an aged decline and an aged terminated-loan decision are
 * pseudonymised and an open loan's, a live application's and a young one's are
 * not; the append-only trigger still refuses every other UPDATE, the
 * identifying columns changed outside the function, a non-NULL value and a
 * second pseudonymisation; a second run is a no-op; and the outcomes of a
 * pseudonymised record survive the nightly outcome writer. Run as a role RLS
 * binds. Every person, lender and amount is synthetic.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/retention/retention.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { recordData } from "../decision-log"
import { OUTCOME_DEFINITION_VERSION } from "../outcomes/definition"
import { syncOutcomes, type OutcomeWriterDb } from "../outcomes/writer"
import { consumerDeclineRecord } from "../records"
import { pseudonymiseTenantDecisionRecords, runDecisionRecordRetention } from "./job"

const suite = process.env.RUN_DECISION_LOG_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_decision_retention_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
const asOf = new Date("2027-06-01T00:00:00.000Z")
const monthsAgo = (n: number) => new Date(Date.UTC(2027, 5 - n, 1))
const REASON = "Bureau flag cleared after a manual review."
let app: ReturnType<typeof createAppPrismaClient>
let tenant: ChargesTenant
let offTenant: ChargesTenant
const ids: Record<string, string> = {}

async function record(owner: ChargesTenant, name: string, subject: { applicationId?: string; loanId?: string; clientId?: string; leadId?: string }, decidedAt: Date, extra: Record<string, unknown> = {}) {
  const base = recordData(consumerDeclineRecord({
    tenantId: owner.tenantId, applicationId: subject.applicationId ?? "unused", clientId: null,
    actor: { userId: owner.userId, role: "LOAN_ADMIN" }, decidedAt, declineCategory: "OTHER",
  }))
  const row = await db.creditDecisionRecord.create({
    data: { ...base, applicationId: subject.applicationId ?? null, loanId: subject.loanId ?? null, clientId: subject.clientId ?? null, leadId: subject.leadId ?? null, ...extra },
  })
  ids[name] = row.id
}

/** A booked loan (client, application, loan) ended as `end`, or left open. */
async function loan(owner: ChargesTenant, end: { status: "COMPLETED" | "WRITTEN_OFF" | "CANCELLED"; at: Date } | null) {
  const { loanId, clientId } = await createChargesLoan(db, owner)
  const { applicationId } = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true } })
  if (end) {
    // The loan status guards (a cancellation needs a disbursement reversal) are not under test here.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.loan.update({
        where: { id: loanId },
        data: end.status === "WRITTEN_OFF" ? { status: end.status, writeOffAt: end.at } : { status: end.status, closedAt: end.at },
      }),
    ])
  }
  return { loanId, clientId, applicationId }
}

const rows = (owner: ChargesTenant) => db.creditDecisionRecord.findMany({ where: { tenantId: owner.tenantId }, orderBy: { id: "asc" } })
const fn = (frame: ChargesTenant, subject: ChargesTenant) => runWithTenant(frame.tenantId, async () => (await app.$queryRaw<{ n: number }[]>`
  SELECT public."pseudonymiseCreditDecisionRecords"(${subject.tenantId}, ${asOf.toISOString()}::timestamptz) AS n`)[0].n)
const run = (owner: ChargesTenant, at = asOf) => runWithTenant(owner.tenantId, () => pseudonymiseTenantDecisionRecords(owner.tenantId, at, app))
const pseudonymised = async (owner: ChargesTenant) =>
  new Set((await rows(owner)).filter((r) => r.pseudonymisedAt !== null).map((r) => Object.keys(ids).find((k) => ids[k] === r.id)))

async function createAppRole(): Promise<string> {
  const password = randomBytes(12).toString("hex")
  const exists = await db.$queryRaw<unknown[]>`SELECT 1 FROM pg_roles WHERE rolname = ${ROLE}`
  if (exists.length === 0) await db.$executeRawUnsafe(`CREATE ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS`)
  await db.$executeRawUnsafe(`ALTER ROLE ${ROLE} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '${password}'`)
  await db.$executeRawUnsafe(`GRANT USAGE ON SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE}`)
  await db.$executeRawUnsafe(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE}`)
  return password
}

function roleUrl(password: string): string {
  const url = new URL(process.env.DATABASE_URL ?? "")
  url.username = ROLE
  url.password = password
  url.searchParams.set("connection_limit", "1")
  return url.toString()
}

suite("decision log retention (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    offTenant = await createChargesTenant(db, false)
    const open = await loan(tenant, null)
    const settledLongAgo = await loan(tenant, { status: "COMPLETED", at: monthsAgo(24) })
    const settledRecently = await loan(tenant, { status: "COMPLETED", at: monthsAgo(6) })
    const writtenOff = await loan(tenant, { status: "WRITTEN_OFF", at: monthsAgo(24) })
    const cancelled = await loan(tenant, { status: "CANCELLED", at: monthsAgo(24) })
    // Applications with no loan: one still being worked, one declined.
    const [live, declined] = await Promise.all((["SUBMITTED", "DECLINED"] as const).map(async (status) => {
      const clientId = `c-${status.toLowerCase()}-${t}`
      await db.client.create({
        data: { id: clientId, tenantId: tenant.tenantId, idNumber: `91${t}${status.length}`, firstName: "Retention", lastName: "Test", email: `${clientId}@client.invalid`, phone: "0820000001" },
      })
      return db.loanApplication.create({
        data: { tenantId: tenant.tenantId, reference: `APP-${status}-${t}`, clientId, productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 31, status },
      })
    }))

    await record(tenant, "declineAged", { clientId: `c-declined-${t}` }, monthsAgo(24), { overridden: true, overrideReason: REASON })
    await record(tenant, "declineYoung", { clientId: `c-young-${t}` }, monthsAgo(6))
    await record(tenant, "leadRefusalAged", { leadId: `lead-${t}` }, monthsAgo(30), { actorType: "SYSTEM", actorUserId: null, actorRole: null, s71ReviewRequired: true })
    // Nothing but a lead and no actor: the one shape a bare UPDATE of the identifying columns could take.
    await record(tenant, "leadRefusalYoung", { leadId: `lead-young-${t}` }, monthsAgo(3), { actorType: "SYSTEM", actorUserId: null, actorRole: null, s71ReviewRequired: true })
    await record(tenant, "declinedApplicationAged", { applicationId: declined.id }, monthsAgo(24))
    // However old, a decision on an application still being worked does not age.
    await record(tenant, "liveApplication", { applicationId: live.id }, monthsAgo(60))
    await record(tenant, "openLoan", { applicationId: open.applicationId, loanId: open.loanId, clientId: open.clientId }, monthsAgo(60))
    await record(tenant, "settledAged", { applicationId: settledLongAgo.applicationId, loanId: settledLongAgo.loanId, clientId: settledLongAgo.clientId }, monthsAgo(40))
    await record(tenant, "settledAgedByApplicationOnly", { applicationId: settledLongAgo.applicationId }, monthsAgo(40))
    // Decided long ago, but the loan ended only 6 months ago: the loan's end is the clock.
    await record(tenant, "settledRecently", { applicationId: settledRecently.applicationId, loanId: settledRecently.loanId }, monthsAgo(60))
    await record(tenant, "writtenOffAged", { applicationId: writtenOff.applicationId, loanId: writtenOff.loanId }, monthsAgo(40))
    await record(tenant, "cancelledAged", { applicationId: cancelled.applicationId, loanId: cancelled.loanId }, monthsAgo(40))
    await record(offTenant, "offTenantDeclineAged", { clientId: `c-off-${t}` }, monthsAgo(60))

    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(roleUrl(await createAppRole()))
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    const owners = [tenant, offTenant].filter(Boolean).map((o) => o.tenantId)
    // Append-only: the replica role skips its trigger, as the other decision log suites do.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.decisionOutcome.deleteMany({ where: { tenantId: { in: owners } } }),
      db.creditDecisionRecord.deleteMany({ where: { tenantId: { in: owners } } }),
    ])
    await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public."pseudonymiseCreditDecisionRecords"(integer)`)
    if (app) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE ${ROLE}`)
    }
    await db.$disconnect()
  })

  it("connects as a role RLS binds (otherwise the frame proves nothing)", async () => {
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
  })

  it("changes nothing for a lender with no period, however old its records are", async () => {
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })).decisionRecordRetentionMonths).toBeNull()
    expect(await run(tenant)).toEqual({ retentionMonths: null, pseudonymised: 0 })
    expect(await fn(tenant, tenant)).toBe(0)
    expect(await pseudonymised(tenant)).toEqual(new Set())
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, action: "DECISION_RECORDS_PSEUDONYMISED" } })).toBe(0)
  })

  it("does not reach another lender's records from a lender's frame (RLS), even with a period set", async () => {
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { decisionRecordRetentionMonths: 12 } })
    expect(await fn(offTenant, tenant)).toBe(0)
    expect(await pseudonymised(tenant)).toEqual(new Set())
  })

  it("pseudonymises what has aged past the period and nothing else, then does nothing the second time", async () => {
    const before = await rows(tenant)

    expect(await run(tenant)).toEqual({ retentionMonths: 12, pseudonymised: 7 })
    expect(await pseudonymised(tenant)).toEqual(new Set([
      "declineAged", "leadRefusalAged", "declinedApplicationAged", "settledAged", "settledAgedByApplicationOnly", "writtenOffAged", "cancelledAged",
    ]))

    const after = new Map((await rows(tenant)).map((r) => [r.id, r]))
    for (const was of before) {
      const now = after.get(was.id)!
      if (now.pseudonymisedAt === null) {
        expect(now).toEqual(was)
        continue
      }
      expect(now).toMatchObject({
        applicationId: null, loanId: null, clientId: null, leadId: null, actorUserId: null, overrideReason: null, pseudonymisedAt: asOf,
      })
      // Everything else, the banded aggregate columns included, is as it was.
      expect({ ...now, applicationId: null, loanId: null, clientId: null, leadId: null, actorUserId: null, overrideReason: null, pseudonymisedAt: null })
        .toEqual({ ...was, applicationId: null, loanId: null, clientId: null, leadId: null, actorUserId: null, overrideReason: null, pseudonymisedAt: null })
    }
    // An override keeps its flag and loses its reason.
    expect(after.get(ids.declineAged)).toMatchObject({ overridden: true, overrideReason: null })
    const audits = await db.auditLog.findMany({ where: { tenantId: tenant.tenantId, action: "DECISION_RECORDS_PSEUDONYMISED" } })
    expect(audits.map((a) => a.newValue)).toEqual([{ retentionMonths: 12, pseudonymised: 7, asOf: asOf.toISOString() }])

    expect(await run(tenant)).toEqual({ retentionMonths: 12, pseudonymised: 0 })
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, action: "DECISION_RECORDS_PSEUDONYMISED" } })).toBe(1)
    expect(await rows(tenant)).toEqual([...after.values()])
  })

  it("leaves a lender with no period alone when the nightly sweep runs over every tenant", async () => {
    const result = await runDecisionRecordRetention(asOf)
    expect(result.perTenant).toContainEqual({ tenantId: offTenant.tenantId, retentionMonths: null, pseudonymised: 0 })
    expect(result.perTenant).toContainEqual({ tenantId: tenant.tenantId, retentionMonths: 12, pseudonymised: 0 })
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: ids.offTenantDeclineAged } })).clientId).toBe(`c-off-${t}`)
  })

  it("still refuses every other change, and the identifying columns changed outside the function", async () => {
    const young = ids.declineYoung
    const gone = ids.declineAged
    const refused = (sql: string, ...args: unknown[]) => expect(db.$executeRawUnsafe(sql, ...args)).rejects.toThrow(/append-only/)
    await refused(`UPDATE "CreditDecisionRecord" SET "decision" = 'APPROVE' WHERE "id" = $1`, young)
    await refused(`UPDATE "CreditDecisionRecord" SET "decision" = 'APPROVE' WHERE "id" = $1`, gone)
    await refused(`UPDATE "CreditDecisionRecord" SET "decidedAt" = now() WHERE "id" = $1`, gone)
    await refused(`UPDATE "CreditDecisionRecord" SET "overridden" = false WHERE "id" = $1`, gone)
    // The six identifying columns to NULL and the stamp, as the function does, but not from it.
    await refused(`UPDATE "CreditDecisionRecord" SET "leadId" = NULL, "pseudonymisedAt" = now() WHERE "id" = $1`, ids.leadRefusalYoung)
    await refused(`UPDATE "CreditDecisionRecord" SET "pseudonymisedAt" = now() WHERE "id" = $1`, ids.leadRefusalYoung)
    await refused(`UPDATE "CreditDecisionRecord" SET "clientId" = NULL, "pseudonymisedAt" = now() WHERE "id" = $1`, young)
    await refused(`UPDATE "CreditDecisionRecord" SET "clientId" = 'someone-else' WHERE "id" = $1`, young)
    await expect(runWithTenant(tenant.tenantId, async () => await app.creditDecisionRecord.updateMany({ where: { id: young }, data: { clientId: null } })))
      .rejects.toThrow(/append-only/)
    await refused(`DELETE FROM "CreditDecisionRecord" WHERE "id" = $1`, gone)
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: young } })).clientId).toBe(`c-young-${t}`)
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: ids.leadRefusalYoung } })).pseudonymisedAt).toBeNull()
  })

  // A function of the same name stands in for a call from inside the real one, so the trigger's
  // shape checks run on the call-stack path; it needs CREATE FUNCTION, which the app role lacks.
  it("refuses, even from inside the function, a non-NULL value, another column changed, or a second pseudonymisation", async () => {
    const attempt = async (set: string, id: string) => {
      await db.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION public."pseudonymiseCreditDecisionRecords"(p integer) RETURNS integer LANGUAGE plpgsql AS $f$
        BEGIN UPDATE "CreditDecisionRecord" SET ${set} WHERE "id" = '${id}'; RETURN 1; END $f$`)
      return db.$queryRawUnsafe(`SELECT public."pseudonymiseCreditDecisionRecords"(1)`)
    }
    const nulls = `"applicationId" = NULL, "loanId" = NULL, "clientId" = NULL, "leadId" = NULL, "actorUserId" = NULL, "overrideReason" = NULL, "pseudonymisedAt" = now()`
    await expect(attempt(`${nulls.replace(`"clientId" = NULL`, `"clientId" = 'someone'`)}`, ids.openLoan)).rejects.toThrow(/append-only|pseudonymised_shape/)
    await expect(attempt(`${nulls}, "decision" = 'APPROVE'`, ids.openLoan)).rejects.toThrow(/append-only/)
    await expect(attempt(`${nulls}, "inputsHash" = '${"e".repeat(64)}'`, ids.openLoan)).rejects.toThrow(/append-only/)
    // Already pseudonymised: a second time is refused.
    await expect(attempt(nulls, ids.declineAged)).rejects.toThrow(/append-only/)
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: ids.openLoan } })).pseudonymisedAt).toBeNull()
  })

  it("holds a pseudonymised row to its shape, and an unpseudonymised one to its reason, actor and subject", async () => {
    const base = recordData(consumerDeclineRecord({
      tenantId: tenant.tenantId, applicationId: `app-shape-${t}`, clientId: null, actor: { userId: tenant.userId, role: "LOAN_ADMIN" }, decidedAt: monthsAgo(1),
      declineCategory: "OTHER",
    }))
    const create = (change: Record<string, unknown>) => db.creditDecisionRecord.create({ data: { ...base, ...change } })
    await expect(create({ pseudonymisedAt: asOf })).rejects.toThrow("CreditDecisionRecord_pseudonymised_shape")
    await expect(create({ overridden: true, overrideReason: null })).rejects.toThrow("CreditDecisionRecord_override_reason")
    await expect(create({ actorUserId: null })).rejects.toThrow("CreditDecisionRecord_actor")
    await expect(create({ applicationId: null })).rejects.toThrow("CreditDecisionRecord_has_subject_or_lead")
  })

  it("keeps a pseudonymised record's outcomes when the outcome writer sweeps decisions it no longer attributes", async () => {
    const outcome = (decisionRecordId: string) => ({
      tenantId: tenant.tenantId, decisionRecordId, outcomeKind: "EVER_90_DPD" as const, window: "12M", state: "OBSERVED" as const, value: false,
      sourceSystem: "credaflow", sourceRef: `loan-${decisionRecordId}`, definitionVersion: OUTCOME_DEFINITION_VERSION,
      observedAt: asOf, computedAt: asOf,
    })
    await db.decisionOutcome.createMany({ data: [outcome(ids.settledAged), outcome(ids.openLoan)] })

    // A run that attributes only the young decline: the other two are no longer attributed.
    // The writer is typed for the app's extended client; a plain one serves here.
    await syncOutcomes(db as unknown as OutcomeWriterDb, { tenantId: tenant.tenantId, sourceSystem: "credaflow", decisionRecordIds: [ids.declineYoung], outcomes: [], computedAt: asOf, demoData: false })

    const left = await db.decisionOutcome.findMany({ where: { tenantId: tenant.tenantId }, select: { decisionRecordId: true } })
    expect(left.map((o) => o.decisionRecordId)).toEqual([ids.settledAged])
  })
})
