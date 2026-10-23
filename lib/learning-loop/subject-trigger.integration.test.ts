/**
 * Real-Postgres proof of the subject-consistency trigger (migration
 * 20261023190000_decision_record_subject_trigger): a decision record whose
 * applicationId, loanId, clientId or leadId is not a row of the record's own
 * lender is refused at INSERT, naming the column. An id of another lender and
 * an id that does not exist are both refused; the lender's own is accepted;
 * and a parent erased later leaves its records alone. The cases that need a
 * role RLS binds (the lookups run as the inserting role) are in
 * decision-log.integration.test.ts, which already creates one. Every person and lender is
 * synthetic.
 *
 *   RUN_DECISION_LOG_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/subject-trigger.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { recordData } from "./decision-log"
import { consumerDeclineRecord } from "./records"

const suite = process.env.RUN_DECISION_LOG_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const decidedAt = new Date("2026-10-23T08:00:00.000Z")

interface Lender { tenant: ChargesTenant; applicationId: string; loanId: string; clientId: string; leadId: string }
let a: Lender
let b: Lender

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

suite("decision record subject trigger (real Postgres)", () => {
  beforeAll(async () => {
    a = await lender()
    b = await lender()
  }, 60_000)

  afterAll(async () => {
    const tenantIds = [a?.tenant.tenantId, b?.tenant.tenantId].filter((id): id is string => Boolean(id))
    // Append-only: the replica role skips its trigger, as cleanupDealFixture does.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.creditDecisionRecord.deleteMany({ where: { tenantId: { in: tenantIds } } }),
    ])
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

  it("is insert-only: a parent erased later leaves its records in place", async () => {
    const orphan = await db.lead.create({ data: { tenantId: a.tenant.tenantId, firstName: "Erased", lastName: "Later", phone: "0820000002" } })
    await db.creditDecisionRecord.create({ data: row(a.tenant.tenantId, { leadId: orphan.id }) })
    await db.lead.delete({ where: { id: orphan.id } })
    expect(await db.creditDecisionRecord.count({ where: { tenantId: a.tenant.tenantId, leadId: orphan.id } })).toBe(1)
  })
})
