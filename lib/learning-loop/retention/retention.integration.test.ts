/**
 * Real-Postgres proof of decision log retention (migrations
 * 20261023200000_decision_record_retention and its 60-month floor,
 * 20261024150000_decision_record_retention_floor): with no period nothing changes;
 * with one, an aged decline and an aged terminated-loan decision are
 * pseudonymised and an open loan's, a live application's and a young one's are
 * not; the append-only trigger still refuses every other UPDATE and, from the
 * role the application uses (not the table owner), the pseudonymising UPDATE
 * itself however it is dressed (a comment mimicking the call stack, a forged
 * flag), a record born pseudonymised, a function call with no tenant frame or
 * with a caller-chosen clock; from inside the function it refuses a non-NULL
 * value, another column changed and a second pseudonymisation; what is
 * pseudonymised includes the source entity, the evidence refs, the inputs hash
 * and the outcomes' loan reference; a second run is a no-op; and the outcomes
 * of a pseudonymised record survive the nightly outcome writer. Every person,
 * lender and amount is synthetic.
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
import { countDecisionRecordsAgedBy } from "./preview"

const suite = process.env.RUN_DECISION_LOG_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_decision_retention_it"
const t = randomUUID().replaceAll("-", "").slice(0, 12)
// The function reads the database clock, so the fixtures are dated from now.
const monthsAgo = (n: number) => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - n, 15)) }
const REASON = "Bureau flag cleared after a manual review."
/** The legal floor on a period (60 months): every fixture is dated past it, and the lender's period is FLOOR + 12. */
const FLOOR = 60
const PERIOD = FLOOR + 12
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
/** The database function called straight, as a session in `frame`'s tenant frame (or none). */
const fn = (frame: ChargesTenant | null) => {
  const call = async () => (await app.$queryRaw<{ n: number }[]>`SELECT public."pseudonymiseCreditDecisionRecords"() AS n`)[0].n
  return frame ? runWithTenant(frame.tenantId, call) : call()
}
const run = (owner: ChargesTenant) => runWithTenant(owner.tenantId, () => pseudonymiseTenantDecisionRecords(owner.tenantId, app))
const FLAG = `SELECT set_config('cf.decision_record_pseudonymise', txid_current()::text, true)`
/** The seven identifying columns, the source entity, the hash and the refs, as the function sets them. */
const WIPE = `"applicationId" = NULL, "loanId" = NULL, "clientId" = NULL, "leadId" = NULL, "actorUserId" = NULL, "overrideReason" = NULL,
  "sourceEntityId" = NULL, "inputsHash" = NULL, "evidenceRefs" = '{}'::jsonb, "pseudonymisedAt" = now()`
const WIPED = ["applicationId", "loanId", "clientId", "leadId", "actorUserId", "overrideReason", "sourceEntityId", "inputsHash", "pseudonymisedAt"] as const
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
    const settledLongAgo = await loan(tenant, { status: "COMPLETED", at: monthsAgo(FLOOR + 24) })
    const settledRecently = await loan(tenant, { status: "COMPLETED", at: monthsAgo(FLOOR + 6) })
    const writtenOff = await loan(tenant, { status: "WRITTEN_OFF", at: monthsAgo(FLOOR + 24) })
    const cancelled = await loan(tenant, { status: "CANCELLED", at: monthsAgo(FLOOR + 24) })
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

    // Subjects must exist as rows of the lender (the INSERT trigger of 20261023190000): the clients and leads the records name.
    const person = (owner: ChargesTenant, id: string, n: number) => db.client.create({
      data: { id, tenantId: owner.tenantId, idNumber: `92${t}${n}`, firstName: "Retention", lastName: "Subject", email: `${id}@client.invalid`, phone: "0820000002" },
    })
    // `c-declined-…` is the declined application's client, created above.
    await person(tenant, `c-young-${t}`, 2)
    await person(offTenant, `c-off-${t}`, 3)
    for (const id of [`lead-young-${t}`, `lead-${t}`]) {
      await db.lead.create({ data: { id, tenantId: tenant.tenantId, firstName: "Retention", lastName: "Lead", phone: "0820000003" } })
    }
    ids.declinedApplication = declined.id
    await record(tenant, "declineAged", { clientId: `c-declined-${t}` }, monthsAgo(FLOOR + 24), { overridden: true, overrideReason: REASON })
    await record(tenant, "declineYoung", { clientId: `c-young-${t}` }, monthsAgo(FLOOR + 6))
    // Nothing but a lead and no actor: the one shape a bare UPDATE of the identifying columns could take.
    await record(tenant, "leadRefusalYoung", { leadId: `lead-young-${t}` }, monthsAgo(FLOOR + 3), { actorType: "SYSTEM", actorUserId: null, actorRole: null, s71ReviewRequired: true })
    await record(tenant, "leadRefusalAged", { leadId: `lead-${t}` }, monthsAgo(FLOOR + 30), { actorType: "SYSTEM", actorUserId: null, actorRole: null, s71ReviewRequired: true })
    // The subject trigger is insert-only: a parent erased later (DSAR) leaves the record, which still pseudonymises.
    await db.lead.create({ data: { id: `lead-erased-${t}`, tenantId: tenant.tenantId, firstName: "Retention", lastName: "Erased", phone: "0820000004" } })
    await record(tenant, "leadErasedAged", { leadId: `lead-erased-${t}` }, monthsAgo(FLOOR + 30), { actorType: "SYSTEM", actorUserId: null, actorRole: null, s71ReviewRequired: true })
    await db.lead.delete({ where: { id: `lead-erased-${t}` } })
    await record(tenant, "declinedApplicationAged", { applicationId: declined.id }, monthsAgo(FLOOR + 24))
    // However old, a decision on an application still being worked does not age.
    await record(tenant, "liveApplication", { applicationId: live.id }, monthsAgo(FLOOR + 60))
    // A record naming only a client does not age while that client has an open loan or a live application.
    await record(tenant, "clientOnlyOpenLoan", { clientId: open.clientId }, monthsAgo(FLOOR + 60))
    await record(tenant, "clientOnlyLiveApplication", { clientId: live.clientId! }, monthsAgo(FLOOR + 60))
    await record(tenant, "openLoan", { applicationId: open.applicationId, loanId: open.loanId, clientId: open.clientId }, monthsAgo(FLOOR + 60))
    await record(tenant, "settledAged", { applicationId: settledLongAgo.applicationId, loanId: settledLongAgo.loanId, clientId: settledLongAgo.clientId }, monthsAgo(FLOOR + 40), {
      evidenceRefs: { bureauCheckId: `bureau-${t}` },
    })
    await record(tenant, "settledAgedByApplicationOnly", { applicationId: settledLongAgo.applicationId }, monthsAgo(FLOOR + 40))
    // Decided long ago, but the loan ended only FLOOR + 6 months ago: the loan's end is the clock.
    await record(tenant, "settledRecently", { applicationId: settledRecently.applicationId, loanId: settledRecently.loanId }, monthsAgo(FLOOR + 60))
    await record(tenant, "writtenOffAged", { applicationId: writtenOff.applicationId, loanId: writtenOff.loanId }, monthsAgo(FLOOR + 40))
    await record(tenant, "cancelledAged", { applicationId: cancelled.applicationId, loanId: cancelled.loanId }, monthsAgo(FLOOR + 40))
    await record(offTenant, "offTenantDeclineAged", { clientId: `c-off-${t}` }, monthsAgo(FLOOR + 60))
    // An outcome that names the loan, as the outcome job writes it.
    await db.decisionOutcome.create({
      data: {
        tenantId: tenant.tenantId, decisionRecordId: ids.settledAged, outcomeKind: "EVER_90_DPD", window: "12M", state: "OBSERVED", value: false,
        sourceSystem: "credaflow", sourceRef: settledLongAgo.loanId, definitionVersion: OUTCOME_DEFINITION_VERSION, observedAt: monthsAgo(FLOOR + 25), computedAt: monthsAgo(FLOOR + 25),
      },
    })
    ids.settledLoan = settledLongAgo.loanId

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
    if (app) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE ${ROLE}`)
    }
    await db.$disconnect()
  })

  it("connects as a role RLS binds that does not own the table (otherwise the attacks prove nothing)", async () => {
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean; owner: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass,
        rolname = (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = '"CreditDecisionRecord"'::regclass) AS owner
      FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false, owner: false })
  })

  it("changes nothing for a lender with no period, however old its records are", async () => {
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: tenant.tenantId } })).decisionRecordRetentionMonths).toBeNull()
    expect(await run(tenant)).toEqual({ retentionMonths: null, pseudonymised: 0 })
    expect(await fn(tenant)).toBe(0)
    expect(await pseudonymised(tenant)).toEqual(new Set())
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, action: "DECISION_RECORDS_PSEUDONYMISED" } })).toBe(0)
  })

  it("takes its tenant from the frame and its clock from the database: no frame, no argument", async () => {
    await db.tenantConfig.update({ where: { tenantId: tenant.tenantId }, data: { decisionRecordRetentionMonths: PERIOD } })
    await expect(fn(null)).rejects.toThrow(/needs a tenant frame/)
    // The old signature took a tenant and an as-of; a caller can no longer choose either.
    await expect(runWithTenant(tenant.tenantId, async () => await app.$queryRaw`SELECT public."pseudonymiseCreditDecisionRecords"(${tenant.tenantId}, '2100-01-01'::timestamptz)`))
      .rejects.toThrow(/does not exist/)
    // Another lender's frame, with its own period off, reaches nothing of this lender's.
    expect(await fn(offTenant)).toBe(0)
    expect(await pseudonymised(tenant)).toEqual(new Set())
  })

  it("previews how many records a period would pseudonymise, from the job's own clock, changing nothing", async () => {
    const count = (months: number) => runWithTenant(tenant.tenantId, () => countDecisionRecordsAgedBy(tenant.tenantId, months, app))
    const before = await rows(tenant)
    expect(await count(PERIOD)).toBe(8)
    // FLOOR + 5 also reaches the decline and the loan settled FLOOR + 6 months ago; FLOOR + 100 reaches nothing.
    expect(await count(FLOOR + 5)).toBe(10)
    expect(await count(FLOOR + 100)).toBe(0)
    // Another lender's frame counts only its own records, however old.
    expect(await runWithTenant(offTenant.tenantId, () => countDecisionRecordsAgedBy(offTenant.tenantId, PERIOD, app))).toBe(1)
    expect(await rows(tenant)).toEqual(before)
  })

  it("pseudonymises what has aged past the period and nothing else, then does nothing the second time", async () => {
    const before = await rows(tenant)

    expect(await run(tenant)).toEqual({ retentionMonths: PERIOD, pseudonymised: 8 })
    expect(await pseudonymised(tenant)).toEqual(new Set([
      "declineAged", "leadRefusalAged", "leadErasedAged", "declinedApplicationAged", "settledAged", "settledAgedByApplicationOnly", "writtenOffAged", "cancelledAged",
    ]))

    const after = new Map((await rows(tenant)).map((r) => [r.id, r]))
    const blank = (r: object) => ({ ...r, ...Object.fromEntries(WIPED.map((c) => [c, null])), evidenceRefs: {} })
    for (const was of before) {
      const now = after.get(was.id)!
      if (now.pseudonymisedAt === null) {
        expect(now).toEqual(was)
        continue
      }
      expect(now).toMatchObject({
        applicationId: null, loanId: null, clientId: null, leadId: null, actorUserId: null, overrideReason: null,
        sourceEntityId: null, inputsHash: null, evidenceRefs: {},
      })
      expect(Math.abs(now.pseudonymisedAt.getTime() - Date.now())).toBeLessThan(60_000)
      // Everything else, the banded aggregate columns included, is as it was.
      expect(blank(now)).toEqual(blank(was))
    }
    // An override keeps its flag and loses its reason; the evidence ids are gone.
    expect(after.get(ids.declineAged)).toMatchObject({ overridden: true, overrideReason: null })
    expect(before.find((r) => r.id === ids.settledAged)!.evidenceRefs).toEqual({ bureauCheckId: `bureau-${t}` })
    // The outcome keeps its figures but no longer names the loan.
    const outcome = await db.decisionOutcome.findFirstOrThrow({ where: { decisionRecordId: ids.settledAged } })
    expect(outcome).toMatchObject({ state: "OBSERVED", value: false, outcomeKind: "EVER_90_DPD", sourceRef: outcome.id })
    expect(outcome.sourceRef).not.toBe(ids.settledLoan)

    const audits = await db.auditLog.findMany({ where: { tenantId: tenant.tenantId, action: "DECISION_RECORDS_PSEUDONYMISED" } })
    expect(audits.map((a) => a.newValue)).toEqual([{ retentionMonths: PERIOD, pseudonymised: 8 }])

    expect(await run(tenant)).toEqual({ retentionMonths: PERIOD, pseudonymised: 0 })
    expect(await runWithTenant(tenant.tenantId, () => countDecisionRecordsAgedBy(tenant.tenantId, PERIOD, app))).toBe(0)
    expect(await db.auditLog.count({ where: { tenantId: tenant.tenantId, action: "DECISION_RECORDS_PSEUDONYMISED" } })).toBe(1)
    expect(await rows(tenant)).toEqual([...after.values()])
  })

  it("leaves a lender with no period alone when the nightly sweep runs over every tenant", async () => {
    const result = await runDecisionRecordRetention()
    expect(result.perTenant).toContainEqual({ tenantId: offTenant.tenantId, retentionMonths: null, pseudonymised: 0 })
    expect(result.perTenant).toContainEqual({ tenantId: tenant.tenantId, retentionMonths: PERIOD, pseudonymised: 0 })
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: ids.offTenantDeclineAged } })).clientId).toBe(`c-off-${t}`)
  })

  it("still refuses every other change to a record, from the owner and from the application role", async () => {
    const young = ids.declineYoung
    const gone = ids.declineAged
    const refused = (sql: string, ...args: unknown[]) => expect(db.$executeRawUnsafe(sql, ...args)).rejects.toThrow(/append-only/)
    await refused(`UPDATE "CreditDecisionRecord" SET "decision" = 'APPROVE' WHERE "id" = $1`, young)
    await refused(`UPDATE "CreditDecisionRecord" SET "decision" = 'APPROVE' WHERE "id" = $1`, gone)
    await refused(`UPDATE "CreditDecisionRecord" SET "decidedAt" = now() WHERE "id" = $1`, gone)
    await refused(`UPDATE "CreditDecisionRecord" SET "overridden" = false WHERE "id" = $1`, gone)
    // The whole pseudonymisation, as the function does it, but not from it: the owner too is refused without the function's flag.
    await refused(`UPDATE "CreditDecisionRecord" SET ${WIPE} WHERE "id" = $1`, ids.leadRefusalYoung)
    await refused(`UPDATE "CreditDecisionRecord" SET "pseudonymisedAt" = now() WHERE "id" = $1`, ids.leadRefusalYoung)
    await refused(`UPDATE "CreditDecisionRecord" SET "clientId" = 'someone-else' WHERE "id" = $1`, young)
    await expect(runWithTenant(tenant.tenantId, async () => await app.creditDecisionRecord.updateMany({ where: { id: young }, data: { clientId: null } })))
      .rejects.toThrow(/append-only/)
    await refused(`DELETE FROM "CreditDecisionRecord" WHERE "id" = $1`, gone)
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: young } })).clientId).toBe(`c-young-${t}`)
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: ids.leadRefusalYoung } })).pseudonymisedAt).toBeNull()
  })

  // Reviewer attacks, run as the application role in the lender's frame against rows the job must NOT touch.
  describe("as the application role", () => {
    const victims = () => [ids.openLoan, ids.liveApplication, ids.declineYoung, ids.leadRefusalYoung].map((id) => `'${id}'`).join(", ")
    const inFrame = <T>(fnc: () => Promise<T>) => runWithTenant(tenant.tenantId, fnc)
    const untouched = async () => {
      const rows = await db.creditDecisionRecord.findMany({ where: { id: { in: [ids.openLoan, ids.liveApplication, ids.declineYoung, ids.leadRefusalYoung] } } })
      expect(rows.map((r) => r.pseudonymisedAt)).toEqual([null, null, null, null])
    }

    it("cannot pseudonymise by writing the function's name in a comment (the call stack is no proof)", async () => {
      await expect(inFrame(async () => await app.$executeRawUnsafe(`DO $d$ BEGIN
        UPDATE "CreditDecisionRecord" SET "applicationId" = NULL, "loanId" = NULL, "clientId" = NULL, "leadId" = NULL, "actorUserId" = NULL,
          "overrideReason" = NULL, "sourceEntityId" = NULL, "inputsHash" = NULL, "evidenceRefs" = '{}'::jsonb, "pseudonymisedAt" = '1999-01-01'
          /* PL/pgSQL function "pseudonymiseCreditDecisionRecords"( */ WHERE "id" IN (${victims()});
        END $d$`))).rejects.toThrow(/append-only/)
      await untouched()
    })

    it("cannot pseudonymise by setting the function's flag itself (it is not the table owner)", async () => {
      await expect(inFrame(async () => await app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(FLAG)
        await tx.$executeRawUnsafe(`UPDATE "CreditDecisionRecord" SET ${WIPE} WHERE "id" IN (${victims()})`)
      }))).rejects.toThrow(/append-only/)
      await untouched()
    })

    it("cannot create a record already pseudonymised, which would skip the subject, actor and reason checks", async () => {
      const born = (as: "db" | "app") => {
        const sql = `INSERT INTO "CreditDecisionRecord" ("id","tenantId","kind","decision","recommendation","overridden","actorType","sourceEntityType","ruleVersion","policyHash",
          "inputsSnapshot","evidenceRefs","decidedAt","pseudonymisedAt")
          VALUES ('born-${as}-${t}', '${tenant.tenantId}', 'CREDIT_DECISION', 'DECLINE', 'NONE', true, 'STAFF', 'LoanApplication', 'v1', '${"c".repeat(64)}', '{}', '{}', now(), now())`
        return as === "db" ? db.$executeRawUnsafe(sql) : inFrame(async () => await app.$executeRawUnsafe(sql))
      }
      await expect(born("db")).rejects.toThrow(/cannot be created pseudonymised/)
      await expect(born("app")).rejects.toThrow(/cannot be created pseudonymised/)
      expect(await db.creditDecisionRecord.count({ where: { id: { startsWith: "born-" } } })).toBe(0)
    })
  })

  // The owner with the function's flag is the path the function takes, so the guard's own shape checks run here.
  it("refuses, even on the function's own path, a non-NULL value, another column changed, kept evidence or a second pseudonymisation", async () => {
    const attempt = (set: string, id: string) => db.$transaction([db.$executeRawUnsafe(FLAG), db.$executeRawUnsafe(`UPDATE "CreditDecisionRecord" SET ${set} WHERE "id" = '${id}'`)])
    await expect(attempt(WIPE.replace(`"leadId" = NULL`, `"leadId" = 'someone'`), ids.leadRefusalYoung)).rejects.toThrow(/append-only|pseudonymised_shape/)
    await expect(attempt(`${WIPE}, "decision" = 'APPROVE'`, ids.leadRefusalYoung)).rejects.toThrow(/append-only/)
    await expect(attempt(`${WIPE}, "policyHash" = '${"e".repeat(64)}'`, ids.leadRefusalYoung)).rejects.toThrow(/append-only/)
    await expect(attempt(WIPE.replace(`"evidenceRefs" = '{}'::jsonb`, `"evidenceRefs" = '{"keep":"me"}'::jsonb`), ids.leadRefusalYoung)).rejects.toThrow(/append-only|pseudonymised_shape/)
    await expect(attempt(WIPE.replace(`"sourceEntityId" = NULL`, `"sourceEntityId" = 'kept'`), ids.leadRefusalYoung)).rejects.toThrow(/append-only|pseudonymised_shape/)
    await expect(attempt(WIPE.replace(`"inputsHash" = NULL`, `"inputsHash" = '${"f".repeat(64)}'`), ids.leadRefusalYoung)).rejects.toThrow(/append-only|pseudonymised_shape/)
    // Already pseudonymised: a second time is refused.
    await expect(attempt(WIPE, ids.declineAged)).rejects.toThrow(/append-only/)
    expect((await db.creditDecisionRecord.findUniqueOrThrow({ where: { id: ids.leadRefusalYoung } })).pseudonymisedAt).toBeNull()
  })

  it("holds a pseudonymised row to its shape, and an unpseudonymised one to its reason, actor, subject and source", async () => {
    const base = recordData(consumerDeclineRecord({
      tenantId: tenant.tenantId, applicationId: ids.declinedApplication, clientId: null, actor: { userId: tenant.userId, role: "LOAN_ADMIN" }, decidedAt: monthsAgo(1),
      declineCategory: "OTHER",
    }))
    const create = (change: Record<string, unknown>) => db.creditDecisionRecord.create({ data: { ...base, ...change } })
    await expect(create({ overridden: true, overrideReason: null })).rejects.toThrow("CreditDecisionRecord_override_reason")
    await expect(create({ actorUserId: null })).rejects.toThrow("CreditDecisionRecord_actor")
    await expect(create({ applicationId: null })).rejects.toThrow("CreditDecisionRecord_has_subject_or_lead")
    await expect(create({ sourceEntityId: null })).rejects.toThrow("CreditDecisionRecord_identity_present")
    await expect(create({ inputsHash: null })).rejects.toThrow("CreditDecisionRecord_identity_present")
  })

  it("keeps a pseudonymised record's outcomes when the outcome writer sweeps decisions it no longer attributes", async () => {
    const outcome = (decisionRecordId: string) => ({
      tenantId: tenant.tenantId, decisionRecordId, outcomeKind: "EVER_90_DPD" as const, window: "12M", state: "OBSERVED" as const, value: false,
      sourceSystem: "credaflow", sourceRef: `loan-${decisionRecordId}`, definitionVersion: OUTCOME_DEFINITION_VERSION,
      observedAt: monthsAgo(1), computedAt: monthsAgo(1),
    })
    await db.decisionOutcome.create({ data: outcome(ids.openLoan) })

    // A run that attributes only the young decline: the other two are no longer attributed.
    // The writer is typed for the app's extended client; a plain one serves here.
    await syncOutcomes(db as unknown as OutcomeWriterDb, { tenantId: tenant.tenantId, sourceSystem: "credaflow", decisionRecordIds: [ids.declineYoung], outcomes: [], computedAt: new Date(), demoData: false })

    const left = await db.decisionOutcome.findMany({ where: { tenantId: tenant.tenantId }, select: { decisionRecordId: true } })
    expect(left.map((o) => o.decisionRecordId)).toEqual([ids.settledAged])
  })

  it("holds a lender's period to 60..600 months or off, whoever writes it", async () => {
    const set = (months: number | null) => db.$executeRaw`UPDATE "TenantConfig" SET "decisionRecordRetentionMonths" = ${months} WHERE "tenantId" = ${offTenant.tenantId}`
    for (const months of [1, 59, 601]) {
      await expect(set(months), String(months)).rejects.toMatchObject({ meta: { code: "23514" } })
    }
    for (const months of [60, 600, null]) expect(await set(months), String(months)).toBe(1)
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId: offTenant.tenantId } })).decisionRecordRetentionMonths).toBeNull()
  })
})
