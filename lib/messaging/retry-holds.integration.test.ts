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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesTenant, SCHEDULE_TOTAL, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
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

// A fixed morning, so the dunning send window (07:00-20:00 SAST, the day it was created) does not depend on when the suite runs.
const CREATED = new Date("2026-11-03T08:00:00Z") // 10:00 SAST
const SWEEP_AT = new Date("2026-11-03T09:00:00Z") // 11:00 SAST

async function queueMessage(contactId: string, category: TemplateCategory, dunning: boolean, idempotencyKey?: string, createdAt: Date = CREATED): Promise<string> {
  // One conversation per contact: later messages join it.
  const conversation = await db.conversation.findFirst({ where: { tenantId: tenant.tenantId, contactId } })
    ?? await db.conversation.create({ data: { tenantId: tenant.tenantId, contactId, channel: "SMS" } })
  return (await db.message.create({
    data: {
      tenantId: tenant.tenantId, conversationId: conversation.id, channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS",
      status: "RETRYING", retryCount: 1, nextRetryAt: new Date("2000-01-01T00:00:00Z"), templateId: templates[category]!,
      lawfulBasis: "SERVICE_COMMS_NCA", bodyText: "Synthetic message", toValue: "+27820000000", dunning, idempotencyKey, createdAt,
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
      { name: "completed", status: "COMPLETED", held: true },
      { name: "cancelled", status: "CANCELLED", held: true },
      { name: "defaulted", status: "DEFAULTED", held: true },
    ] as HoldCase[]) {
      const seeded = await seedHoldLoan(db, tenant, second, c)
      const contact = await db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: seeded.clientId } })
      messages[`${c.name}/collections reminder`] = await queueMessage(contact.id, "SERVICE", true, `collections:${seeded.loanId}:reminder_7d:SMS:${day}`)
      messages[`${c.name}/entity reminder`] = await queueMessage(contact.id, "SERVICE", true, `entity-notice:${seeded.loanId}:reminder_1d:${day}:${seeded.clientId}:SMS`)
      messages[`${c.name}/manual reminder`] = await queueMessage(contact.id, "SERVICE", true, `manual-reminder:${seeded.loanId}:op1:SMS`)
      messages[`${c.name}/entity loan_overdue notice`] = await queueMessage(contact.id, "SERVICE", true, `entity-notice:${seeded.loanId}:loan_overdue:${day}:${seeded.clientId}:SMS`)
      messages[`${c.name}/loan_overdue notice`] = await queueMessage(contact.id, "SERVICE", true, `notification:loan_overdue:${seeded.loanId}:${day}:SMS`)
      messages[`${c.name}/collections statement`] = await queueMessage(contact.id, "SERVICE", false, `collections:${seeded.loanId}:statement:SMS:${day}`)
    }
    // A reminder queued for retry, then the borrower pays: what it says is no longer true.
    for (const c of [{ name: "owing" }, { name: "paid" }]) {
      const seeded = await seedHoldLoan(db, tenant, second, { name: c.name, held: false }, { inArrears: true })
      const contact = await db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: seeded.clientId } })
      if (c.name === "paid") {
        await db.loan.update({ where: { id: seeded.loanId }, data: { arrearsAmount: 0, daysInArrears: 0 } })
        await db.repaymentSchedule.updateMany({ where: { loanId: seeded.loanId }, data: { totalPaid: SCHEDULE_TOTAL, status: "PAID" } })
      }
      messages[`${c.name}/overdue reminder`] = await queueMessage(contact.id, "SERVICE", true, `collections:${seeded.loanId}:reminder_overdue_3d:SMS:${day}`)
      messages[`${c.name}/pre-due reminder`] = await queueMessage(contact.id, "SERVICE", true, `collections:${seeded.loanId}:reminder_7d:SMS:${day}`)
      messages[`${c.name}/entity overdue reminder`] = await queueMessage(contact.id, "SERVICE", true, `entity-notice:${seeded.loanId}:reminder_overdue_1d:${day}:${seeded.clientId}:SMS`)
      messages[`${c.name}/notice`] = await queueMessage(contact.id, "SERVICE", true, `notification:loan_overdue:${seeded.loanId}:${day}:SMS`)
    }
    const lead = await db.contact.create({ data: { tenantId: tenant.tenantId, firstSeenChannel: "SMS", status: "LEAD" } })
    messages["lead/reminder"] = await queueMessage(lead.id, "SERVICE", true)
    await processRetryBatch({ limit: 500, now: SWEEP_AT })
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

  // The loan_overdue notification is also the 60-DPD DEFAULTED notice: the escalation cron flips the loan to
  // DEFAULTED and then sends it, so a retry of it must still go to a DEFAULTED loan.
  it.each(["arrangement", "plan", "attorney", "completed", "cancelled"])("a retry of the loan_overdue notice on a %s loan is suppressed", async (hold) => {
    expect(await row(`${hold}/loan_overdue notice`)).toMatchObject({ status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining("loan hold") })
  })

  it("a retry of the loan_overdue notice on a DEFAULTED loan with no other hold still goes: it is the notice of the default", async () => {
    const name = "defaulted/loan_overdue notice"
    expect((await row(name)).errorMessage ?? "").not.toContain("loan hold")
    expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED")).toBe(1)
  })

  // The same notice to an ENTITY borrower shares the `entity-notice:` key prefix with the entity reminders.
  it("a retry of the ENTITY loan_overdue notice on a DEFAULTED loan still goes, like the consumer one", async () => {
    const name = "defaulted/entity loan_overdue notice"
    expect((await row(name)).errorMessage ?? "").not.toContain("loan hold")
    expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED")).toBe(1)
  })

  it.each(["arrangement", "plan", "attorney", "completed", "cancelled"])("a retry of the entity loan_overdue notice on a %s loan is suppressed", async (hold) => {
    expect(await row(`${hold}/entity loan_overdue notice`)).toMatchObject({ status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining("loan hold") })
  })

  it("a retry of an ENTITY reminder on a DEFAULTED loan is suppressed, unlike its notice: only an ACTIVE loan is reminded", async () => {
    expect(await row("defaulted/entity reminder")).toMatchObject({ status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining("the loan is DEFAULTED") })
  })

  it.each([["completed", "COMPLETED"], ["cancelled", "CANCELLED"], ["defaulted", "DEFAULTED"]])("a retry of a reminder on a %s loan is suppressed: only an ACTIVE loan is reminded", async (hold, status) => {
    expect(await row(`${hold}/collections reminder`)).toMatchObject({ status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining(`the loan is ${status}`) })
  })

  it("a staff reminder is not held by the loan's status either", async () => {
    for (const hold of ["completed", "cancelled", "defaulted"]) {
      expect((await row(`${hold}/manual reminder`)).errorMessage ?? "", hold).not.toContain("loan hold")
    }
  })

  // A key names a loan id; a message of ANOTHER tenant that happens to carry the id of this tenant's held loan
  // must not be held by it (the lookup is by tenant and id).
  it("another tenant's message is not held by this tenant's held loan", async () => {
    const other = await createChargesTenant(db, false)
    const contact = await db.contact.create({ data: { tenantId: other.tenantId, firstSeenChannel: "SMS", status: "CLIENT" } })
    const conversation = await db.conversation.create({ data: { tenantId: other.tenantId, contactId: contact.id, channel: "SMS" } })
    const heldLoan = (await db.loan.findFirstOrThrow({ where: { tenantId: tenant.tenantId, paymentArrangement: { is: { status: "ACTIVE" } } } })).id
    const tpl = await db.messageTemplate.create({ data: { tenantId: other.tenantId, event: "retry_hold_x", key: `retry_hold_x_${randomUUID()}`, channel: "SMS", body: "x", category: "SERVICE" } })
    const id = (await db.message.create({
      data: {
        tenantId: other.tenantId, conversationId: conversation.id, channel: "SMS", direction: "OUTBOUND", provider: "BULKSMS", status: "RETRYING",
        retryCount: 1, nextRetryAt: new Date("2000-01-01T00:00:00Z"), templateId: tpl.id, lawfulBasis: "SERVICE_COMMS_NCA", bodyText: "Synthetic",
        toValue: "+27820000000", dunning: true, idempotencyKey: `collections:${heldLoan}:reminder_7d:SMS:2026-11-01`, createdAt: CREATED,
      },
    })).id
    await processRetryBatch({ limit: 500, now: SWEEP_AT })
    expect((await db.message.findUniqueOrThrow({ where: { id } })).errorMessage ?? "").not.toContain("loan hold")
    expect(await db.auditLog.count({ where: { entityId: id, action: "MESSAGE_RETRY_DISPATCH_CLAIMED" } })).toBe(1)
  })

  it.each(["overdue reminder", "pre-due reminder", "entity overdue reminder"])("a retried %s on a loan that is still owing goes", async (kind) => {
    expect((await row(`owing/${kind}`)).errorMessage ?? "", kind).not.toContain("nothing is owed")
    expect(await audits(`owing/${kind}`, "MESSAGE_RETRY_DISPATCH_CLAIMED"), kind).toBe(1)
  })

  it.each(["overdue reminder", "pre-due reminder", "entity overdue reminder"])("a retried %s after the borrower paid is suppressed: nothing is owed", async (kind) => {
    expect(await row(`paid/${kind}`)).toMatchObject({ status: "SUPPRESSED_BY_CONSENT", errorMessage: expect.stringContaining("nothing is owed") })
    expect(await audits(`paid/${kind}`, "MESSAGE_RETRY_DISPATCH_CLAIMED")).toBe(0)
  })

  // A 60-DPD notice is a statement of the default, not a demand for an amount: it is not held for being paid.
  it("a retried loan_overdue notice is not held by 'nothing is owed'", async () => {
    expect((await row("paid/notice")).errorMessage ?? "").not.toContain("nothing is owed")
  })

  it("a loan with no hold is not suppressed", async () => {
    for (const kind of ["collections reminder", "entity reminder", "manual reminder"]) {
      const name = `no hold/${kind}`
      expect((await row(name)).errorMessage ?? "", name).not.toContain("hold")
      expect(await audits(name, "MESSAGE_RETRY_DISPATCH_CLAIMED"), name).toBe(1)
    }
  })

  // ALL dunning retries (the automated reminders, staff reminders and the 60-DPD notices) go only 07:00-20:00 SAST.
  // Outside it a message stays due: its nextRetryAt moves to the next 07:00, so it does not sit at the front of
  // the batch. Only an automated, date-worded REMINDER (`collections:`, `entity-notice:<reminder>`) also goes stale
  // at the end of its creation day and EXPIRES ("due TOMORROW" a day late); a staff reminder and a 60-DPD notice
  // keep the sweep's ordinary 24 hour expiry.
  describe("the dunning send window", () => {
    const clean = () => db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, client: { lastName: { startsWith: "clean" } } } })
    type Kind = "reminder" | "entity reminder" | "staff" | "notice" | "entity notice" | "unkeyed" | "statement"
    const KEYS: Record<Kind, (n: string) => string | undefined> = {
      reminder: (n) => `collections:window:${n}`,
      "entity reminder": (n) => `entity-notice:window:reminder_1d:${n}:cl:SMS`,
      staff: (n) => `manual-reminder:window:${n}:SMS`,
      notice: (n) => `notification:loan_overdue:window:${n}:SMS`,
      "entity notice": (n) => `entity-notice:window:loan_overdue:${n}:cl:SMS`,
      unkeyed: () => undefined,
      statement: () => undefined,
    }
    const queue = async (kind: Kind, n: string, created: Date) =>
      queueMessage((await clean()).id, "SERVICE", kind !== "statement", KEYS[kind](n), created)
    const sweep = (now: string, limit = 500) => processRetryBatch({ limit, now: new Date(now) })
    const state = (id: string) => db.message.findUniqueOrThrow({ where: { id } })
    const claimed = (id: string) => db.auditLog.count({ where: { entityId: id, action: "MESSAGE_RETRY_DISPATCH_CLAIMED" } })

    it.each(["reminder", "entity reminder", "staff", "notice", "entity notice", "unkeyed"] as Kind[])(
      "a %s waits at 05:00 SAST and at 21:00 SAST of its day, and is rescheduled to the next 07:00",
      async (kind) => {
        const early = await queue(kind, `early-${kind}`, new Date("2026-11-04T00:30:00Z")) // created 02:30 SAST on the 4th
        await sweep("2026-11-04T03:00:00Z") // 05:00 SAST, same day
        expect(await state(early)).toMatchObject({ status: "RETRYING", errorClass: null, nextRetryAt: new Date("2026-11-04T05:00:00Z") })
        const evening = await queue(kind, `evening-${kind}`, new Date("2026-11-04T16:00:00Z")) // 18:00 SAST
        await sweep("2026-11-04T19:00:00Z") // 21:00 SAST, same day
        expect(await state(evening)).toMatchObject({ status: "RETRYING", nextRetryAt: new Date("2026-11-05T05:00:00Z") })
        expect(await claimed(early)).toBe(0)
        expect(await claimed(evening)).toBe(0)
      },
    )

    it("sends a dunning message that is due inside the window", async () => {
      const midday = await queue("reminder", "midday", new Date("2026-11-05T06:00:00Z"))
      await sweep("2026-11-05T09:00:00Z") // 11:00 SAST, same day
      expect((await state(midday)).status).not.toBe("RETRYING")
      expect(await claimed(midday)).toBe(1)
    })

    it.each(["reminder", "entity reminder"] as Kind[])("expires an automated %s that was not sent by the end of its day, at 05:00 and at 11:00 SAST, rather than send it", async (kind) => {
      for (const now of ["2026-11-07T03:00:00Z", "2026-11-07T09:00:00Z"]) {
        // 14:00 SAST on the 6th: under 24 h before both sweeps, so it is the day rule that expires it.
        const stale = await queue(kind, `stale-${kind}-${now}`, new Date("2026-11-06T12:00:00Z"))
        await sweep(now)
        expect(await state(stale)).toMatchObject({ status: "EXPIRED", errorClass: "EXPIRED", nextRetryAt: null })
        expect(await claimed(stale)).toBe(0)
      }
    })

    // The wording of these is not dated, so a night is only a wait, not an expiry.
    it.each(["staff", "notice", "entity notice", "unkeyed"] as Kind[])("does not expire a %s at the end of its day: it waits through the night and goes at 11:00", async (kind) => {
      const created = new Date("2026-11-09T12:00:00Z") // 14:00 SAST on the 9th
      const id = await queue(kind, `overnight-${kind}`, created)
      await sweep("2026-11-09T22:30:00Z") // 00:30 SAST on the 10th, next calendar day
      await sweep("2026-11-10T03:00:00Z") // 05:00 SAST
      expect(await state(id)).toMatchObject({ status: "RETRYING", errorClass: null })
      await sweep("2026-11-10T09:00:00Z") // 11:00 SAST, 21 h after it was created
      expect(await claimed(id)).toBe(1)
    })

    // The sweep's blanket 24 hour expiry would drop a message queued at 10:00 before the next morning's window opens
    // (the last backoff is 12 hours). A staff reminder or a 60-DPD notice gets that next window, and expires after it.
    it.each(["staff", "notice", "entity notice"] as Kind[])("a %s created yesterday still goes in the next morning's window, 25 hours on", async (kind) => {
      const id = await queue(kind, `next-morning-${kind}`, new Date("2026-11-14T08:00:00Z")) // 10:00 SAST on the 14th
      await sweep("2026-11-15T09:00:00Z") // 11:00 SAST on the 15th
      expect(await claimed(id)).toBe(1)
    })

    it.each(["staff", "notice", "entity notice"] as Kind[])("a %s expires once the next day's window is over, at 20:30 SAST", async (kind) => {
      const id = await queue(kind, `window-over-${kind}`, new Date("2026-11-16T08:00:00Z")) // 10:00 SAST on the 16th
      await sweep("2026-11-17T18:30:00Z") // 20:30 SAST on the 17th
      expect(await state(id)).toMatchObject({ status: "EXPIRED", errorClass: "EXPIRED", nextRetryAt: null })
      expect(await claimed(id)).toBe(0)
    })

    it("still expires a message that is not dunning after 24 hours, as before", async () => {
      const id = await queue("statement", "old-statement", new Date("2026-11-18T08:00:00Z"))
      await sweep("2026-11-19T09:00:00Z") // 25 hours on
      expect(await state(id)).toMatchObject({ status: "EXPIRED" })
    })

    it("does not change a message that is not dunning: it is still sent at 21:00 SAST", async () => {
      const statement = await queue("statement", "statement", new Date("2026-11-08T08:00:00Z"))
      await sweep("2026-11-08T19:00:00Z") // 21:00 SAST
      expect(await claimed(statement)).toBe(1)
    })

    // A big batch can run for minutes: the window is judged at the moment of each send, not when the sweep began.
    it("judges the window when it reaches the message, not when the sweep started", async () => {
      const id = await queue("staff", "slow-sweep", new Date("2026-11-12T10:00:00Z"))
      const real = Date.now.bind(Date)
      let calls = 0
      // The first reading is the sweep's start; every later one is an hour on (19:30 SAST -> 20:30 SAST).
      const clock = vi.spyOn(Date, "now").mockImplementation(() => (calls++ === 0 ? real() : real() + 3_600_000))
      try {
        await sweep("2026-11-12T17:30:00Z")
      } finally {
        clock.mockRestore()
      }
      expect(await claimed(id)).toBe(0)
      expect((await state(id)).nextRetryAt).toEqual(new Date("2026-11-13T05:00:00Z"))
    })

    // A waiting row kept its old nextRetryAt, stayed at the front of the batch (oldest first, `take: limit`) and
    // starved everything behind it. Now it is rescheduled to the next 07:00, so the next batch reaches the others.
    it("a batch full of waiting dunning rows does not starve a non-dunning row behind them", async () => {
      const head = new Date("1999-01-01T00:00:00Z")
      const waiting = await Promise.all(
        [1, 2, 3].map((n) => queue("reminder", `starve-${n}`, new Date("2026-11-11T00:30:00Z")).then((id) => db.message.update({ where: { id }, data: { nextRetryAt: head } }).then(() => id))),
      )
      const behind = await queue("statement", "starve-behind", new Date("2026-11-11T00:30:00Z"))
      await db.message.update({ where: { id: behind }, data: { nextRetryAt: new Date("1999-06-01T00:00:00Z") } })

      await sweep("2026-11-11T03:00:00Z", 3) // 05:00 SAST: the three waiting rows fill the whole batch
      expect(await claimed(behind), "the batch was spent on rows that only wait").toBe(0)
      for (const id of waiting) expect((await state(id)).nextRetryAt).toEqual(new Date("2026-11-11T05:00:00Z"))

      await sweep("2026-11-11T03:01:00Z", 3)
      expect(await claimed(behind), "the next batch reaches it").toBe(1)
    })
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
