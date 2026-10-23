/**
 * Real-Postgres proof of the subject-consistency trigger (migration
 * 20261023190000_decision_record_subject_trigger): a decision record whose
 * applicationId, loanId, clientId or leadId is not a row of the record's own
 * lender is refused at INSERT, naming the column. An id of another lender and
 * an id that does not exist are both refused; the lender's own is accepted,
 * also from a role RLS binds (the lookups run as the inserting role); and a
 * parent erased later leaves its records alone. Every person and lender is
 * synthetic.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/subject-trigger.integration.test.ts
 */
import { randomBytes, randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createAppPrismaClient } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { recordData } from "./decision-log"
import { consumerDeclineRecord } from "./records"

const suite = process.env.RUN_DECISION_LOG_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const ROLE = "cf_subject_trigger_it"
const decidedAt = new Date("2026-10-23T08:00:00.000Z")

interface Lender { tenant: ChargesTenant; applicationId: string; loanId: string; clientId: string; leadId: string }
let a: Lender
let b: Lender
let app: ReturnType<typeof createAppPrismaClient>

async function lender(): Promise<Lender> {
  const tenant = await createChargesTenant(db, false)
  const { loanId, clientId } = await createChargesLoan(db, tenant)
  const { applicationId } = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true } })
  const lead = await db.lead.create({ data: { tenantId: tenant.tenantId, firstName: "Subject", lastName: "Test", phone: "0820000001" } })
  return { tenant, applicationId, loanId, clientId, leadId: lead.id }
}

type Subject = { applicationId?: string; loanId?: string; clientId?: string; leadId?: string }
const row = (tenantId: string, subject: Subject) => ({
  ...recordData(consumerDeclineRecord({
    tenantId, applicationId: subject.applicationId ?? "unused", clientId: null,
    actor: { userId: "user-1", role: "LOAN_ADMIN" }, decidedAt, declineCategory: "OTHER",
  })),
  applicationId: null, loanId: null, clientId: null, leadId: null,
  ...subject,
})

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

suite("decision record subject trigger (real Postgres)", () => {
  beforeAll(async () => {
    a = await lender()
    b = await lender()
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.username = ROLE
    url.password = await createAppRole()
    url.searchParams.set("connection_limit", "1")
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient(url.toString())
  }, 60_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await app?.$disconnect()
    const tenantIds = [a?.tenant.tenantId, b?.tenant.tenantId].filter((id): id is string => Boolean(id))
    // Append-only: the replica role skips its trigger, as cleanupDealFixture does.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.creditDecisionRecord.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    ])
    if (app) {
      await db.$executeRawUnsafe(`DROP OWNED BY ${ROLE}`)
      await db.$executeRawUnsafe(`DROP ROLE ${ROLE}`)
    }
    await db.$disconnect()
  })

  const columns = [
    ["applicationId", (l: Lender) => l.applicationId],
    ["loanId", (l: Lender) => l.loanId],
    ["clientId", (l: Lender) => l.clientId],
    ["leadId", (l: Lender) => l.leadId],
  ] as const

  describe.each(columns)("%s", (column, idOf) => {
    it("refuses an id of another lender, naming the column", async () => {
      await expect(db.creditDecisionRecord.create({ data: row(a.tenant.tenantId, { [column]: idOf(b) }) }))
        .rejects.toThrow(new RegExp(`CreditDecisionRecord\\.${column} is not`))
    })

    it("refuses an id that does not exist, naming the column", async () => {
      await expect(db.creditDecisionRecord.create({ data: row(a.tenant.tenantId, { [column]: `missing-${randomUUID()}` }) }))
        .rejects.toThrow(new RegExp(`CreditDecisionRecord\\.${column} is not`))
    })

    it("accepts the lender's own id", async () => {
      const created = await db.creditDecisionRecord.create({ data: row(a.tenant.tenantId, { [column]: idOf(a) }) })
      expect(created).toMatchObject({ tenantId: a.tenant.tenantId, [column]: idOf(a) })
    })
  })

  it("refuses a record when any one of several subject ids is foreign", async () => {
    await expect(db.creditDecisionRecord.create({
      data: row(a.tenant.tenantId, { applicationId: a.applicationId, clientId: b.clientId }),
    })).rejects.toThrow(/CreditDecisionRecord\.clientId is not/)
  })

  it("accepts every subject of the lender together", async () => {
    await db.creditDecisionRecord.create({
      data: row(a.tenant.tenantId, { applicationId: a.applicationId, loanId: a.loanId, clientId: a.clientId, leadId: a.leadId }),
    })
  })

  it("checks the lookups as a role RLS binds: own ids pass, another lender's do not", async () => {
    const [me] = await app.$queryRaw<{ su: boolean; bypass: boolean }[]>`
      SELECT rolsuper AS su, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`
    expect(me).toEqual({ su: false, bypass: false })
    const own = row(b.tenant.tenantId, { applicationId: b.applicationId, clientId: b.clientId, loanId: b.loanId, leadId: b.leadId })
    expect(await runWithTenant(b.tenant.tenantId, async () => await app.creditDecisionRecord.create({ data: own })))
      .toMatchObject({ tenantId: b.tenant.tenantId })
    const foreign = row(b.tenant.tenantId, { clientId: a.clientId })
    await expect(runWithTenant(b.tenant.tenantId, async () => await app.creditDecisionRecord.create({ data: foreign })))
      .rejects.toThrow(/CreditDecisionRecord\.clientId is not/)
  })

  it("is insert-only: a parent erased later leaves its records in place", async () => {
    const orphan = await db.lead.create({ data: { tenantId: a.tenant.tenantId, firstName: "Erased", lastName: "Later", phone: "0820000002" } })
    await db.creditDecisionRecord.create({ data: row(a.tenant.tenantId, { leadId: orphan.id }) })
    await db.lead.delete({ where: { id: orphan.id } })
    expect(await db.creditDecisionRecord.count({ where: { tenantId: a.tenant.tenantId, leadId: orphan.id } })).toBe(1)
  })
})
