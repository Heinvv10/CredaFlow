/**
 * Real-Postgres proof that EVERY collections reminder goes through sendMessage
 * (lib/messaging/send.ts): the consent / block gate, the WhatsApp kill switches,
 * the dunning holds and Message.dunning all apply, and the reminder cron has no
 * other way to reach a borrower. The old direct-BulkSMS path, which had none of
 * these gates, is gone (MESSAGING_NEW_SEND_COLLECTIONS was retired).
 *
 * Only the provider TRANSPORTS are stubbed (the WhatsApp Cloud and SMS senders).
 * Eligibility, the kill switches in dispatch(), the holds, the Message rows and
 * the templates run for real. A borrower that must not be reached is proven
 * unreached by the absence of a transport call to its (unique, synthetic)
 * number AND of a Message row; a borrower that must be reached by the presence
 * of both.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/reminders.consent.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import {
  createSecondProduct, HOLD_CASES, seedHoldLoan, type SeededHoldLoan,
} from "@/lib/collections/dunning-holds.integration-fixture"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import { normalisePhone, toWaJid } from "@/lib/contact/identity"

// Provider message ids are unique per provider in the database: reuse across runs would leave rows QUEUED.
const wire = vi.hoisted(() => ({
  whatsapp: [] as string[], sms: [] as string[], legacyWhatsapp: [] as string[],
}))

vi.mock("@/lib/whatsapp-cloud", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/whatsapp-cloud")>()),
  sendWhatsAppCloudMessage: vi.fn(async (a: { to: string }) => (wire.whatsapp.push(a.to), { ok: true, messageId: `wamid-${randomUUID()}` })),
}))
vi.mock("@/lib/integrations/bulksms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/bulksms")>()),
  sendSms: vi.fn(async (a: { to: string }) => (wire.sms.push(a.to), { ok: true, messageId: `sms-${randomUUID()}` })),
  // The retired legacy leg called this directly; nothing may any more.
  sendWhatsApp: vi.fn(async (a: { to: string }) => (wire.legacyWhatsapp.push(a.to), { ok: true, messageId: "legacy" })),
}))

import { prisma } from "@/lib/prisma"
import { processPaymentReminders } from "@/lib/collections/reminders"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

let tenant: ChargesTenant
let secondProductId: string

const waJid = (s: SeededHoldLoan) => toWaJid(s.whatsapp)
const smsNumber = (s: SeededHoldLoan) => normalisePhone(s.phone)
const reached = (s: SeededHoldLoan) => ({
  whatsapp: wire.whatsapp.includes(waJid(s)),
  sms: wire.sms.includes(smsNumber(s)),
})
const messagesOf = (s: SeededHoldLoan) =>
  db.message.findMany({ where: { tenantId: tenant.tenantId, toValue: { in: [waJid(s), smsNumber(s)] } } })
const notesOf = (s: SeededHoldLoan) =>
  db.loanNote.findMany({ where: { tenantId: tenant.tenantId, loanId: s.loanId, type: "reminder_7d" } })

const fresh = (name: string, hold: Partial<Parameters<typeof seedHoldLoan>[3]> = {}) =>
  seedHoldLoan(db, tenant, secondProductId, { name, held: false, ...hold })

suite.sequential("collections reminders go through sendMessage (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await seedDefaultMessageTemplates(db, tenant.tenantId, "Acme Lending")
    await db.commsSettings.upsert({
      where: { tenantId: tenant.tenantId },
      create: { tenantId: tenant.tenantId, whatsappEnabled: true, waProvider: "WA_CLOUD" },
      update: { whatsappEnabled: true, waProvider: "WA_CLOUD" },
    })
    secondProductId = await createSecondProduct(db, tenant.tenantId)
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })
  beforeEach(() => {
    wire.whatsapp.length = wire.sms.length = wire.legacyWhatsapp.length = 0
  })
  afterEach(() => {
    delete process.env.WA_ENABLED
  })

  it("a normal client is reminded on both channels; each Message row is dunning, and the legacy BulkSMS WhatsApp is never called", async () => {
    const normal = await fresh("normal")

    await processPaymentReminders()

    expect(reached(normal)).toEqual({ whatsapp: true, sms: true })
    const rows = await messagesOf(normal)
    expect(rows.map((m) => m.channel).sort()).toEqual(["SMS", "WHATSAPP"])
    for (const m of rows) {
      expect(m.dunning, `${m.channel} reminder must be flagged dunning`).toBe(true)
      expect(m.status).toBe("SENT")
      expect(m.direction).toBe("OUTBOUND")
    }
    expect(await notesOf(normal)).toHaveLength(1)
    expect(wire.legacyWhatsapp).toEqual([])
  })

  it("an opted-out client gets no collections reminder: nothing on the wire, no Message row, no LoanNote", async () => {
    const optedOut = await fresh("opted out")
    for (const channel of ["WHATSAPP", "SMS"] as const) {
      await db.contactConsent.create({
        data: { tenantId: tenant.tenantId, contactId: optedOut.contactId, channel, purpose: "SERVICE_COMMS", status: "REVOKED", source: "MANUAL" },
      })
    }

    await processPaymentReminders()

    expect(reached(optedOut)).toEqual({ whatsapp: false, sms: false })
    expect(await messagesOf(optedOut)).toHaveLength(0)
    expect(await notesOf(optedOut)).toHaveLength(0)
  })

  it("an opt-out of ONE channel stops that channel only", async () => {
    const smsOnly = await fresh("whatsapp opted out")
    await db.contactConsent.create({
      data: { tenantId: tenant.tenantId, contactId: smsOnly.contactId, channel: "WHATSAPP", purpose: "SERVICE_COMMS", status: "REVOKED", source: "MANUAL" },
    })

    await processPaymentReminders()

    expect(reached(smsOnly)).toEqual({ whatsapp: false, sms: true })
    expect((await messagesOf(smsOnly)).map((m) => m.channel)).toEqual(["SMS"])
  })

  it("a blocked client gets no collections reminder, whether blockedAt or status BLOCKED", async () => {
    const byTimestamp = await fresh("blocked at")
    const byStatus = await fresh("blocked status")
    await db.contact.update({ where: { id: byTimestamp.contactId }, data: { blockedAt: new Date() } })
    await db.contact.update({ where: { id: byStatus.contactId }, data: { status: "BLOCKED" } })

    await processPaymentReminders()

    for (const blocked of [byTimestamp, byStatus]) {
      expect(reached(blocked), blocked.name).toEqual({ whatsapp: false, sms: false })
      expect(await messagesOf(blocked), blocked.name).toHaveLength(0)
      expect(await notesOf(blocked), blocked.name).toHaveLength(0)
    }
  })

  it.each(["false", "0", "off", ""])("with WA_ENABLED=%j no WhatsApp reminder is sent; the SMS leg is untouched", async (value) => {
    process.env.WA_ENABLED = value
    const loan = await fresh(`wa off ${value}`)

    await processPaymentReminders()

    expect(wire.whatsapp, "no WhatsApp may reach the transport").toEqual([])
    expect(wire.legacyWhatsapp).toEqual([])
    const rows = await messagesOf(loan)
    const wa = rows.filter((m) => m.channel === "WHATSAPP")
    // The refusal is recorded against the Message, never as a send.
    expect(wa, "the refusal must be on the record, not a silent drop").toHaveLength(1)
    for (const m of wa) {
      expect(["SENT", "DELIVERED", "READ"], `WhatsApp row ${m.status}`).not.toContain(m.status)
      expect(m.dunning).toBe(true)
    }
    expect(reached(loan).sms).toBe(true)
  })

  it("with the tenant's own WhatsApp switch off, no WhatsApp reminder is sent", async () => {
    await db.commsSettings.update({ where: { tenantId: tenant.tenantId }, data: { whatsappEnabled: false } })
    try {
      const loan = await fresh("tenant wa off")
      await processPaymentReminders()
      expect(wire.whatsapp).toEqual([])
      expect(reached(loan).sms).toBe(true)
    } finally {
      await db.commsSettings.update({ where: { tenantId: tenant.tenantId }, data: { whatsappEnabled: true } })
    }
  })

  it("a held loan gets nothing, on any channel, whatever the hold; a normal loan beside it is reminded", async () => {
    const normal = await fresh("beside the held")
    const seeded: SeededHoldLoan[] = []
    for (const c of HOLD_CASES.filter((h) => h.held)) seeded.push(await seedHoldLoan(db, tenant, secondProductId, c))

    await processPaymentReminders()

    expect(reached(normal)).toEqual({ whatsapp: true, sms: true })
    expect(seeded.length).toBeGreaterThan(5)
    for (const s of seeded) {
      expect(reached(s), s.name).toEqual({ whatsapp: false, sms: false })
      expect(await messagesOf(s), s.name).toHaveLength(0)
      expect(await notesOf(s), s.name).toHaveLength(0)
    }
  })

  it("every Message row the cron wrote for this tenant is a dunning row", async () => {
    await fresh("dunning flag")
    await processPaymentReminders()

    const rows = await db.message.findMany({ where: { tenantId: tenant.tenantId, direction: "OUTBOUND" } })
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.filter((m) => !m.dunning).map((m) => m.id)).toEqual([])
  })
})
