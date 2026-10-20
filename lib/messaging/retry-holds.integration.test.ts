/**
 * Real-Postgres proof of what the messaging retry sweep (processRetryBatch)
 * holds for a client who has died or gone under debt review
 * (lib/collections/client-holds.ts): only DUNNING (Message.dunning), which is
 * SUPPRESSED with the cause named and no dispatch claimed. A statement, a
 * receipt and a transactional message (an OTP, an application decline) are not
 * held by it and still reach the dispatch step; a clean client's reminder too.
 * (A deceased client's Contact block, not this hold, stops their other messages.)
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/messaging/retry-holds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { PrismaClient, type MsgStatus, type TemplateCategory } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createSecondProduct, seedHoldLoan, type HoldCase } from "@/lib/collections/dunning-holds.integration-fixture"
import { prisma } from "@/lib/prisma"
import { processRetryBatch } from "@/lib/messaging/retry"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
const templates: Partial<Record<TemplateCategory, string>> = {}
const messages: Record<string, string> = {}

const KINDS = [
  { kind: "reminder", category: "SERVICE", dunning: true },
  { kind: "statement", category: "SERVICE", dunning: false },
  { kind: "receipt", category: "SERVICE", dunning: false },
  { kind: "otp", category: "TRANSACTIONAL", dunning: false },
  { kind: "decline", category: "TRANSACTIONAL", dunning: false },
] as const

async function queueMessage(contactId: string, category: TemplateCategory, dunning: boolean, idempotencyKey?: string): Promise<string> {
  // One conversation per contact: later messages join it.
  const conversation = await db.conversation.findFirst({ where: { tenantId: tenant.tenantId, contactId } })
    ?? await db.conversation.create({ data: { tenantId: tenant.tenantId, contactId, channel: "SMS" } })
  return (await db.message.create({
    data: {
      tenantId: tenant.tenantId, conversationId: conversation.id, channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS",
      status: "RETRYING", retryCount: 1, nextRetryAt: new Date("2000-01-01T00:00:00Z"), templateId: templates[category]!,
      lawfulBasis: "SERVICE_COMMS_NCA", bodyText: "Synthetic message", toValue: "+27820000000", dunning, idempotencyKey,
    },
  })).id
}

async function template(category: TemplateCategory): Promise<string> {
  return (await db.messageTemplate.create({
    data: { tenantId: tenant.tenantId, event: `retry_hold_${category}`, key: `retry_hold_${category}_${randomUUID()}`, channel: "SMS", body: "x", category },
  })).id
}

suite.sequential("retry sweep and client holds (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    const second = await createSecondProduct(db, tenant.tenantId)
    templates.SERVICE = await template("SERVICE")
    templates.TRANSACTIONAL = await template("TRANSACTIONAL")
    const cases: HoldCase[] = [
      { name: "deceased", deceased: true, held: true },
      { name: "debt review", debtReviewOnSibling: true, held: true },
      { name: "clean", held: false },
    ]
    for (const c of cases) {
      const seeded = await seedHoldLoan(db, tenant, second, c)
      const contact = await db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: seeded.clientId } })
      for (const k of KINDS) messages[`${c.name}/${k.kind}`] = await queueMessage(contact.id, k.category, k.dunning)
    }
    // Directors of a borrowing entity: the hold keys on the person's own client, so they are held like anyone.
    const entity = await db.businessEntity.create({
      data: { tenantId: tenant.tenantId, type: "COMPANY", legalName: "Hold Test (Pty) Ltd", registrationNumber: `2026/${randomUUID().slice(0, 6)}/07` },
    })
    for (const c of [
      { name: "director under debt review", debtReviewOnSibling: true, held: true },
      { name: "director deceased", deceased: true, held: true },
    ] as HoldCase[]) {
      const seeded = await seedHoldLoan(db, tenant, second, c)
      await db.entityRelationship.create({ data: { tenantId: tenant.tenantId, entityId: entity.id, clientId: seeded.clientId, role: "DIRECTOR" } })
      const contact = await db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: seeded.clientId } })
      messages[`${c.name}/reminder`] = await queueMessage(contact.id, "SERVICE", true)
    }
    // A loan hold that is not the client's own (an arrangement, a plan, an attorney referral) stops an
    // automated dunning message queued for retry before it, and only that one.
    const day = "2026-11-01"
    for (const c of [
      { name: "arrangement", arrangement: "ACTIVE", held: true },
      { name: "plan", plan: true, held: true },
      { name: "attorney", stage: "ATTORNEY_REFERRED", held: true },
      { name: "no hold", held: false },
    ] as HoldCase[]) {
      const seeded = await seedHoldLoan(db, tenant, second, c)
      const contact = await db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: seeded.clientId } })
      messages[`${c.name}/collections reminder`] = await queueMessage(contact.id, "SERVICE", true, `collections:${seeded.loanId}:reminder_7d:SMS:${day}`)
      messages[`${c.name}/entity reminder`] = await queueMessage(contact.id, "SERVICE", true, `entity-notice:${seeded.loanId}:reminder_1d:${day}:${seeded.clientId}:SMS`)
      messages[`${c.name}/manual reminder`] = await queueMessage(contact.id, "SERVICE", true, `manual-reminder:${seeded.loanId}:op1:SMS`)
      messages[`${c.name}/collections statement`] = await queueMessage(contact.id, "SERVICE", false, `collections:${seeded.loanId}:statement:SMS:${day}`)
    }
    const lead = await db.contact.create({ data: { tenantId: tenant.tenantId, firstSeenChannel: "SMS", status: "LEAD" } })
    messages["lead/reminder"] = await queueMessage(lead.id, "SERVICE", true)
    await processRetryBatch({ limit: 500, now: new Date() })
  })
  afterAll(async () => { await db.$disconnect(); await prisma.$disconnect() })

  const row = (name: string) => db.message.findUniqueOrThrow({ where: { id: messages[name] } })
  const audits = (name: string, action: string) => db.auditLog.count({ where: { entityId: messages[name], action } })

  it.each([
    ["deceased", "client hold: deceased"],
    ["debt review", "client hold: debt review"],
  ])("a %s client's REMINDER retry is suppressed, naming the hold, with no dispatch claimed", async (who, text) => {
    expect(await row(`${who}/reminder`)).toMatchObject({
      status: "SUPPRESSED_BY_CONSENT", errorClass: "CONSENT_REVOKED", dispatchToken: null, errorMessage: expect.stringContaining(text),
    })
    expect(await audits(`${who}/reminder`, "MESSAGE_SUPPRESSED_BY_CONSENT")).toBe(1)
    expect(await audits(`${who}/reminder`, "MESSAGE_RETRY_DISPATCH_CLAIMED")).toBe(0)
  })

  it.each(["deceased", "debt review"])("a %s client's statement, receipt, OTP and decline retries are NOT held: each is claimed for dispatch", async (who) => {
    for (const kind of ["statement", "receipt", "otp", "decline"]) {
      const name = `${who}/${kind}`
      const r = await row(name)
      expect(r.errorMessage ?? "", name).not.toContain("client hold")
      expect(r.status, name).not.toBe("SUPPRESSED_BY_CONSENT")
      expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED"), name).toBe(1)
    }
  })

  // Fail closed: the hold keys on the Contact's own client, not on entity roles.
  it("a director's reminder is held for the director's own debt review, and for a death", async () => {
    expect(await row("director under debt review/reminder")).toMatchObject({
      status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining("client hold: debt review"),
    })
    expect(await audits("director under debt review/reminder", "MESSAGE_RETRY_DISPATCH_CLAIMED")).toBe(0)
    expect(await row("director deceased/reminder")).toMatchObject({
      status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining("client hold: deceased"),
    })
  })

  it.each(["arrangement", "plan", "attorney"])("a retry of an automated reminder on a loan under %s is suppressed, naming the loan hold, with no dispatch claimed", async (hold) => {
    for (const kind of ["collections reminder", "entity reminder"]) {
      const name = `${hold}/${kind}`
      expect(await row(name), name).toMatchObject({
        status: "SUPPRESSED_BY_CONSENT", dispatchToken: null, errorMessage: expect.stringContaining("loan hold"),
      })
      expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED"), name).toBe(0)
    }
  })

  it.each(["arrangement", "plan", "attorney"])("on a loan under %s, a staff reminder and a non-dunning message are NOT held by the loan: staff keep the loan open, and a statement is owed", async (hold) => {
    for (const kind of ["manual reminder", "collections statement"]) {
      const name = `${hold}/${kind}`
      expect((await row(name)).errorMessage ?? "", name).not.toContain("loan hold")
      expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED"), name).toBe(1)
    }
  })

  it("a loan with no hold is not suppressed", async () => {
    for (const kind of ["collections reminder", "entity reminder", "manual reminder"]) {
      const name = `no hold/${kind}`
      expect((await row(name)).errorMessage ?? "", name).not.toContain("hold")
      expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED"), name).toBe(1)
    }
  })

  it("a clean client's reminder, and a lead's, are not suppressed by a hold", async () => {
    for (const name of ["clean/reminder", "lead/reminder"]) {
      const r = await row(name)
      expect(r.errorMessage ?? "", name).not.toContain("client hold")
      expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED"), name).toBe(1)
    }
  })

  // The one-off backfill in the Message.dunning migration: a reminder already queued when it ships.
  it("the backfill flags RETRYING and QUEUED reminders by their template event, nothing else, and is idempotent", async () => {
    const sql = readFileSync(path.join(process.cwd(), "prisma/migrations/20261020042833_message_dunning_flag/migration.sql"), "utf8")
    const statements = sql.split("\n").filter((line) => !line.startsWith("--")).join("\n").split(";").map((t) => t.trim()).filter(Boolean)
    const backfill = statements.slice(1) // the ALTER already ran with the migrations
    expect(backfill.map((t) => t.split(/\s/)[0])).toEqual(["SELECT", "UPDATE", "SELECT"])
    expect(backfill[0]).toContain("app.rls_bypass")

    const eventTemplate = async (event: string) => (await db.messageTemplate.create({
      data: { tenantId: tenant.tenantId, event, key: `${event}_${randomUUID()}`, channel: "SMS", body: "x", category: "SERVICE" },
    })).id
    const reminderTemplate = await eventTemplate("payment_reminder_7d")
    const overdueTemplate = await eventTemplate("loan_overdue")
    const statementTemplate = await eventTemplate("statement_issued")
    const contact = await db.contact.create({ data: { tenantId: tenant.tenantId, firstSeenChannel: "SMS", status: "CLIENT" } })
    const conversation = await db.conversation.create({ data: { tenantId: tenant.tenantId, contactId: contact.id, channel: "SMS" } })
    const make = async (templateId: string, status: MsgStatus) => (await db.message.create({
      data: {
        tenantId: tenant.tenantId, conversationId: conversation.id, channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS", status,
        nextRetryAt: status === "RETRYING" ? new Date("2100-01-01T00:00:00Z") : null, templateId, lawfulBasis: "SERVICE_COMMS_NCA", bodyText: "x", toValue: "+27820000000",
      },
    })).id
    const ids = {
      retryingReminder: await make(reminderTemplate, "RETRYING"),
      queuedOverdue: await make(overdueTemplate, "QUEUED"),
      sentReminder: await make(reminderTemplate, "SENT"),
      retryingStatement: await make(statementTemplate, "RETRYING"),
    }
    const rolledBack = new Error("roll back: the backfill must not touch other suites' rows")
    const seen: { first: number; second: number; flags: Record<string, boolean> } = { first: 0, second: 0, flags: {} }
    const run = async (tx: Pick<PrismaClient, "$executeRawUnsafe">) => {
      let updated = 0
      for (const statement of backfill) {
        const result = await tx.$executeRawUnsafe(statement)
        if (statement.startsWith("UPDATE")) updated = result
      }
      return updated
    }

    await db.$transaction(async (tx) => {
      seen.first = await run(tx)
      seen.second = await run(tx)
      for (const [name, id] of Object.entries(ids)) seen.flags[name] = (await tx.message.findUniqueOrThrow({ where: { id } })).dunning
      throw rolledBack
    }).catch((e) => { if (e !== rolledBack) throw e })

    expect(seen.flags).toEqual({ retryingReminder: true, queuedOverdue: true, sentReminder: false, retryingStatement: false })
    expect(seen.first).toBeGreaterThanOrEqual(2)
    expect(seen.second, "a second run changes nothing").toBe(0)
  })
})
