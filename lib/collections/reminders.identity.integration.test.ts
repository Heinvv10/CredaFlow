/**
 * Real-Postgres proof of what the reminders cron must never do, found by attack
 * (PR #224 review): reach a borrower through SOMEONE ELSE's Contact, lose a
 * loan_overdue the provider rejected, send it twice, or send past an opt-out on
 * the email leg or to a person acting for an entity.
 *
 * Only the provider TRANSPORTS are stubbed (WhatsApp Cloud, BulkSMS SMS, the
 * email service). The Contact lookup, consent, the Message rows, the
 * reservations and the NotificationLog run for real. Synthetic data only.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/reminders.identity.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createChargesTenant, SCHEDULE_TOTAL, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createSecondProduct, seedHoldLoan, type SeededHoldLoan } from "@/lib/collections/dunning-holds.integration-fixture"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import { toWaJid } from "@/lib/contact/identity"
import { sastStartOfDay } from "@/lib/date/sast"

const wire = vi.hoisted(() => ({
  whatsapp: [] as string[], email: [] as string[], emailOk: true, waDelayMs: 0,
  /** Runs while a WhatsApp send is in flight: lets a test change the world mid-send. */
  onWhatsApp: null as null | ((to: string) => Promise<void>),
}))
vi.mock("@/lib/whatsapp-cloud", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-cloud")>()),
  sendWhatsAppCloudMessage: vi.fn(async (a: { to: string }) => {
    if (wire.waDelayMs) await new Promise((resolve) => setTimeout(resolve, wire.waDelayMs))
    if (wire.onWhatsApp) await wire.onWhatsApp(a.to)
    wire.whatsapp.push(a.to)
    return { ok: true, messageId: `wamid-${randomUUID()}` }
  }),
}))
vi.mock("@/lib/integrations/bulksms", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/bulksms")>()),
  sendSms: vi.fn(async () => ({ ok: true, messageId: `sms-${randomUUID()}` })),
}))
vi.mock("@/lib/email/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/service")>()),
  sendEmail: vi.fn(async (a: { to: string }) => {
    wire.email.push(a.to)
    return wire.emailOk
      ? { ok: true, messageId: `em-${randomUUID()}`, providerOutcome: "ACCEPTED" }
      : { ok: false, error: "550 mailbox rejected", providerOutcome: "DEFINITELY_REJECTED" }
  }),
}))
// Inside the send window whatever the clock says (the window has its own pinned-clock test).
vi.mock("@/lib/collections/send-window", async (orig) => ({
  ...(await orig<typeof import("@/lib/collections/send-window")>()),
  outsideDunningSendWindow: () => false,
}))

import { prisma } from "@/lib/prisma"
import { processPaymentReminders } from "@/lib/collections/reminders"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant
let p2: string

const DAY = 86_400_000
const sastDay = (offset: number) => new Date(sastStartOfDay(new Date()).getTime() + offset * DAY)

/** The reminder_overdue_1d offset, which also raises loan_overdue. */
async function makeOverdue1d(s: SeededHoldLoan) {
  await db.loan.update({ where: { id: s.loanId }, data: { nextPaymentDate: sastDay(-1), arrearsAmount: 100_000, daysInArrears: 1 } })
  await db.repaymentSchedule.updateMany({ where: { loanId: s.loanId }, data: { dueDate: sastDay(-1) } })
}

async function revoke(s: SeededHoldLoan, channels: Array<"WHATSAPP" | "SMS" | "EMAIL" | "ALL_CHANNELS">) {
  for (const channel of channels) {
    await db.contactConsent.create({ data: { tenantId: tenant.tenantId, contactId: s.contactId, channel, purpose: "SERVICE_COMMS", status: "REVOKED", source: "MANUAL" } })
  }
}

/** Moves this person's WhatsApp identity to a new LEAD Contact: the number now resolves to someone else. */
async function giveWhatsAppToALead(s: SeededHoldLoan) {
  const lead = await db.contact.create({ data: { tenantId: tenant.tenantId, status: "LEAD", firstSeenChannel: "WHATSAPP" } })
  await db.contactIdentity.updateMany({ where: { contactId: s.contactId, channel: "WHATSAPP" }, data: { contactId: lead.id } })
}

/** An entity borrower's loan, due in 7 days, with these people acting for it as directors. */
async function entityLoan(directors: SeededHoldLoan[]) {
  const id = randomUUID().replaceAll("-", "").slice(0, 12)
  const entity = await db.businessEntity.create({
    data: { tenantId: tenant.tenantId, type: "COMPANY", legalName: `Synthetic ${id} (Pty) Ltd`, registrationNumber: `2026/${id}/07` },
  })
  for (const d of directors) {
    await db.entityRelationship.create({ data: { tenantId: tenant.tenantId, entityId: entity.id, clientId: d.clientId, role: "DIRECTOR" } })
  }
  const app = await db.loanApplication.create({
    data: { tenantId: tenant.tenantId, reference: `APP-E-${id}`, entityId: entity.id, productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 31 },
  })
  const loan = await db.loan.create({
    data: {
      tenantId: tenant.tenantId, reference: `LN-E-${id}`, applicationId: app.id, entityId: entity.id, productId: tenant.productId,
      principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: SCHEDULE_TOTAL, outstandingPrincipal: 200_000,
      startDate: sastDay(-24), maturityDate: sastDay(7), nextPaymentDate: sastDay(7),
      interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE",
    },
  })
  await db.repaymentSchedule.create({
    data: { tenantId: tenant.tenantId, loanId: loan.id, installmentNo: 1, dueDate: sastDay(7), principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: SCHEDULE_TOTAL },
  })
  return loan
}

const entityMessages = (loanId: string) =>
  db.message.findMany({ where: { tenantId: tenant.tenantId, idempotencyKey: { startsWith: `entity-notice:${loanId}:` } }, select: { channel: true, toValue: true } })

suite.sequential("reminders: identity, loan_overdue and consent (real Postgres)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await seedDefaultMessageTemplates(db, tenant.tenantId, "Acme Lending")
    await db.commsSettings.upsert({
      where: { tenantId: tenant.tenantId },
      create: { tenantId: tenant.tenantId, whatsappEnabled: true, waProvider: "WA_CLOUD" },
      update: { whatsappEnabled: true, waProvider: "WA_CLOUD" },
    })
    await db.emailConfig.create({
      data: { tenantId: tenant.tenantId, provider: "IMAP_SMTP", fromName: "Synthetic lender", fromAddress: "sender@synthetic.invalid", smtpHost: "smtp.synthetic.invalid", smtpUser: "synthetic", smtpPass: "synthetic", active: true },
    })
    p2 = await createSecondProduct(db, tenant.tenantId)
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })
  beforeEach(() => {
    wire.whatsapp.length = 0
    wire.email.length = 0
    wire.emailOk = true
    wire.onWhatsApp = null
    wire.waDelayMs = 0
  })

  // A1 (review round 1, reproduced): the opt-out and the block were checked on the
  // LEAD's Contact, which had neither, so the borrower was WhatsApped anyway, and
  // whoever holds that number read the loan.
  it("A1: a blocked, opted-out client whose WhatsApp number resolves to another Contact is not WhatsApped", async () => {
    const s = await seedHoldLoan(db, tenant, p2, { name: "opted out elsewhere", held: false })
    await db.contact.update({ where: { id: s.contactId }, data: { blockedAt: new Date(), status: "BLOCKED" } })
    await revoke(s, ["WHATSAPP", "SMS", "EMAIL", "ALL_CHANNELS"])
    await giveWhatsAppToALead(s)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { reference: true } })

    const r = await processPaymentReminders()

    expect(wire.whatsapp.includes(toWaJid(s.whatsapp)), "opted-out + BLOCKED client must not be WhatsApped").toBe(false)
    expect(r.details).toContainEqual(`Error ${loan.reference} whatsapp: the Contact for this phone number belongs to someone else; not sent`)
    expect(JSON.stringify(r.details)).not.toContain(s.whatsapp.slice(1))
  })

  it("A1 (entity): a director whose WhatsApp number resolves to another Contact is not WhatsApped about the entity's loan", async () => {
    const director = await seedHoldLoan(db, tenant, p2, { name: "director elsewhere", held: false })
    await revoke(director, ["WHATSAPP", "EMAIL"])
    await giveWhatsAppToALead(director)
    const loan = await entityLoan([director])

    await processPaymentReminders()

    expect(wire.whatsapp.includes(toWaJid(director.whatsapp))).toBe(false)
    expect((await entityMessages(loan.id)).filter((m) => m.channel === "WHATSAPP")).toEqual([])
    const note = await db.loanNote.findFirst({ where: { loanId: loan.id, type: "reminder_7d" } })
    expect(note, "nobody was reached, so no reminder is recorded").toBeNull()
  })

  // A2 (review round 1, reproduced): the direct path swallowed the rejection (allSettled),
  // so the run reported no error and the notice looked done.
  it("A2: a definitely rejected loan_overdue email is counted as an error, not resent, and not left looking done", async () => {
    wire.emailOk = false
    const s = await seedHoldLoan(db, tenant, p2, { name: "overdue email rejected", held: false })
    await makeOverdue1d(s)
    const loan = await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { reference: true } })

    const r1 = await processPaymentReminders()
    expect(wire.email).toContain(s.email)
    expect(r1.details, "the rejected loan_overdue email must be in the run's errors").toContainEqual(`Error ${loan.reference} loan_overdue: email failed; see the notification log`)

    const r2 = await processPaymentReminders()
    expect(wire.email.filter((e) => e === s.email), "the provider is not asked again the same day").toHaveLength(1)
    expect(r2.details, "still reported, not quietly done").toContainEqual(`Error ${loan.reference} loan_overdue: email failed; see the notification log`)
    const rows = await db.message.findMany({ where: { tenantId: tenant.tenantId, toValue: s.email, channel: "EMAIL" }, select: { dunning: true, status: true } })
    expect(rows).toEqual([{ dunning: true, status: "FAILED_PERMANENT" }])
  })

  // The direct (flag-off) path also honoured an opt-out, through its own legacy consent
  // check, so the opt-out alone does not tell the paths apart. What does: only the
  // sendMessage path files each leg as a dunning Message row on the client's OWN Contact,
  // and an opted-out leg leaves no row at all.
  it("loan_overdue goes through sendMessage on the client's own Contact, and an email opt-out stops its email", async () => {
    const s = await seedHoldLoan(db, tenant, p2, { name: "overdue opted out of email", held: false })
    await revoke(s, ["EMAIL"])
    await makeOverdue1d(s)

    const r = await processPaymentReminders()

    expect(wire.email).not.toContain(s.email)
    const logs = await db.notificationLog.findMany({ where: { loanId: s.loanId, event: "loan_overdue", channel: "email" }, select: { status: true } })
    expect(logs).toEqual([{ status: "blocked" }])
    const rows = await db.message.findMany({ where: { tenantId: tenant.tenantId, idempotencyKey: { startsWith: `notification:loan_overdue:${s.loanId}:` } }, select: { channel: true, dunning: true, conversation: { select: { contactId: true } } } })
    expect(rows, "the SMS leg is a dunning Message row on the client's own Contact; the opted-out email has none").toEqual([{ channel: "SMS", dunning: true, conversation: { contactId: s.contactId } }])
    const loan = await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { reference: true } })
    expect(r.details.filter((d) => d.startsWith(`Error ${loan.reference}`))).toEqual([])
  })

  // A4 (review round 2, reproduced): the hold was checked before the trigger's legs; a
  // debt-review notice recorded while its WhatsApp was in flight let the overdue email go.
  it("A4: a debt-review notice recorded while the WhatsApp leg is in flight stops the loan_overdue email", async () => {
    const s = await seedHoldLoan(db, tenant, p2, { name: "a4 debt review mid-send", held: false })
    await makeOverdue1d(s)
    const jid = toWaJid(s.whatsapp)
    wire.onWhatsApp = async (to) => {
      if (to === jid) await db.loan.update({ where: { id: s.loanId }, data: { debtReviewNoticeAt: new Date() } })
    }

    await processPaymentReminders()

    expect(wire.whatsapp, "the in-flight WhatsApp itself had already gone").toContain(jid)
    expect(wire.email.filter((e) => e === s.email), "overdue notice emailed to a client under debt review").toHaveLength(0)
    expect(await db.sendReservation.count({ where: { key: `send:${s.loanId}:reminder_overdue_1d:loan_overdue` } }), "given back").toBe(0)
  })

  // Round 4 (breaker, 7 of 9 runs): two runs reach the same leg together. The one that
  // waited on the idempotency advisory lock had a snapshot from before it was granted,
  // missed the row the other committed, hit the unique index and reported the leg as
  // "Error … failed". It must replay that row: a duplicate, not an error, sent once.
  it("two overlapping runs: the second reports Skip duplicate, never an error, and each leg goes once", async () => {
    wire.waDelayMs = 1500
    const s = await seedHoldLoan(db, tenant, p2, { name: "overlapping runs", held: false })
    const loan = await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { reference: true } })

    const [a, b] = await Promise.all([processPaymentReminders(), processPaymentReminders()])

    const lines = [...a.details, ...b.details].filter((d) => d.includes(loan.reference))
    expect(lines.filter((d) => d.startsWith("Error")), "no leg of the overlapping run is an error").toEqual([])
    expect(lines.some((d) => d.startsWith(`Skip duplicate reminder_7d for ${loan.reference}`)), lines.join(" | ")).toBe(true)
    expect(lines.some((d) => d.startsWith("Retry scheduled"))).toBe(false)
    expect(wire.whatsapp.filter((to) => to === toWaJid(s.whatsapp))).toHaveLength(1)
    expect(wire.email.filter((to) => to === s.email)).toHaveLength(1)
  })

  // M8: reserveOnce is mocked in the unit tests; this is the real reservation.
  it("two runs on an overdue offset send exactly one loan_overdue", async () => {
    const s = await seedHoldLoan(db, tenant, p2, { name: "overdue twice", held: false })
    await makeOverdue1d(s)

    await processPaymentReminders()
    await processPaymentReminders()

    expect(wire.email.filter((e) => e === s.email)).toHaveLength(1)
    const logs = await db.notificationLog.findMany({ where: { loanId: s.loanId, event: "loan_overdue", channel: "email" } })
    expect(logs).toHaveLength(1)
    expect(await db.sendReservation.count({ where: { key: `send:${s.loanId}:reminder_overdue_1d:loan_overdue` } })).toBe(1)
  })

  // M6: an EMAIL opt-out or a block must stop the pre-due email leg (the consent suite proves WhatsApp and SMS).
  it("the pre-due email leg: an email opt-out gets no email, a blocked client none, a normal client one", async () => {
    const optedOut = await seedHoldLoan(db, tenant, p2, { name: "email opted out", held: false })
    await revoke(optedOut, ["EMAIL"])
    const blocked = await seedHoldLoan(db, tenant, p2, { name: "email blocked", held: false })
    await db.contact.update({ where: { id: blocked.contactId }, data: { blockedAt: new Date() } })
    const normal = await seedHoldLoan(db, tenant, p2, { name: "email normal", held: false })

    await processPaymentReminders()

    expect(wire.email.filter((e) => e === normal.email)).toHaveLength(1)
    expect(wire.email).not.toContain(optedOut.email)
    expect(wire.email).not.toContain(blocked.email)
    expect(wire.whatsapp, "an email opt-out leaves WhatsApp on").toContain(toWaJid(optedOut.whatsapp))
  })

  // M7: entity legs go through the same gate, per person.
  it("an entity's reminder skips a person who opted out or is blocked, and reaches the one who did not", async () => {
    const revoked = await seedHoldLoan(db, tenant, p2, { name: "entity revoked", held: false })
    await revoke(revoked, ["WHATSAPP", "EMAIL"])
    const blocked = await seedHoldLoan(db, tenant, p2, { name: "entity blocked", held: false })
    await db.contact.update({ where: { id: blocked.contactId }, data: { status: "BLOCKED" } })
    const normal = await seedHoldLoan(db, tenant, p2, { name: "entity normal", held: false })
    const loan = await entityLoan([revoked, blocked, normal])

    await processPaymentReminders()

    const sent = (await entityMessages(loan.id)).map((m) => `${m.channel}:${m.toValue}`).sort()
    expect(sent).toEqual([`EMAIL:${normal.email}`, `WHATSAPP:${toWaJid(normal.whatsapp)}`].sort())
    const note = await db.loanNote.findFirstOrThrow({ where: { loanId: loan.id, type: "reminder_7d" } })
    expect(note.note).toMatch(/blocked/)
  })
})
