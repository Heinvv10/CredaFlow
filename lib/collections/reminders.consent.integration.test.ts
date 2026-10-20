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
import { sendMessage } from "@/lib/messaging/send"
import { runWithTenant } from "@/lib/tenant-scope"

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

  // WhatsApp off is a SKIP, decided before sendMessage: nothing on the wire, no
  // Message row (so no FAILED_PERMANENT one), no error. The transport kill switch
  // is only the backstop (next test).
  it.each(["false", "0", "off", ""])("with WA_ENABLED=%j the WhatsApp leg is skipped, not failed; the SMS leg is untouched", async (value) => {
    process.env.WA_ENABLED = value
    const loan = await fresh(`wa off ${value}`)

    const result = await processPaymentReminders()

    expect(wire.whatsapp, "no WhatsApp may reach the transport").toEqual([])
    expect(wire.legacyWhatsapp).toEqual([])
    const rows = await messagesOf(loan)
    expect(rows.filter((m) => m.channel === "WHATSAPP"), "skipped, so no row at all, least of all a failed one").toEqual([])
    expect(rows.filter((m) => m.status === "FAILED_PERMANENT" || m.status === "FAILED")).toEqual([])
    expect(rows.map((m) => m.channel)).toEqual(["SMS"])
    expect(result.whatsappChannelOff).toBeGreaterThanOrEqual(1)
    expect(result.details.some((d) => /^Skipped \d+ whatsapp leg\(s\) this run: WhatsApp disabled/.test(d))).toBe(true)
    expect(reached(loan).sms).toBe(true)
  })

  it("with the tenant's own WhatsApp switch off, the WhatsApp leg is skipped, not failed", async () => {
    await db.commsSettings.update({ where: { tenantId: tenant.tenantId }, data: { whatsappEnabled: false } })
    try {
      const loan = await fresh("tenant wa off")
      await processPaymentReminders()
      expect(wire.whatsapp).toEqual([])
      expect((await messagesOf(loan)).map((m) => m.channel)).toEqual(["SMS"])
      expect(reached(loan).sms).toBe(true)
    } finally {
      await db.commsSettings.update({ where: { tenantId: tenant.tenantId }, data: { whatsappEnabled: true } })
    }
  })

  it("the transport backstop holds: a WhatsApp sendMessage with WA_ENABLED=false is refused, nothing reaches the transport", async () => {
    process.env.WA_ENABLED = "false"
    const loan = await fresh("backstop")
    const template = await db.messageTemplate.findFirstOrThrow({ where: { tenantId: tenant.tenantId, key: "payment_reminder_1d_whatsapp" } })

    // Called inside the tenant's frame, as the cron does.
    const row = await runWithTenant(tenant.tenantId, () => sendMessage({
      contactId: loan.contactId, channel: "WHATSAPP", template, toValue: waJid(loan), category: "collections", loanId: loan.loanId,
      vars: { firstName: "Hold", amount: "R 1.00", reference: "LN-BACKSTOP", dueDate: "01 Jan 2030", outstanding: "R 1.00", supportPhone: "0110000000" },
    }))

    expect(row.status).not.toBe("SENT")
    expect(wire.whatsapp).toEqual([])
  })

  it("a tenant with no usable templates is warned, not aborted; the others are still reminded", async () => {
    const bare = await createChargesTenant(db, false)
    const bareLoan = await seedHoldLoan(db, bare, await createSecondProduct(db, bare.tenantId), { name: "no templates", held: false })
    await db.commsSettings.create({ data: { tenantId: bare.tenantId, whatsappEnabled: true, waProvider: "WA_CLOUD" } })
    // Each run seeds the defaults a tenant LACKS, and leaves an existing row alone: rows that exist
    // but are inactive (under revision) are what leaves a tenant with nothing usable.
    await seedDefaultMessageTemplates(db, bare.tenantId, "Bare Lending")
    await db.messageTemplate.updateMany({ where: { tenantId: bare.tenantId }, data: { active: false } })
    const ours = await fresh("beside the bare tenant")

    const result = await processPaymentReminders()

    expect(reached(ours)).toEqual({ whatsapp: true, sms: true })
    expect(reached(bareLoan)).toEqual({ whatsapp: false, sms: false })
    expect(result.warnings).toBeGreaterThanOrEqual(1)
    expect(result.details.some((d) => d.startsWith("Warning: sms legs skipped: payment_reminder_sms template missing/inactive"))).toBe(true)
    expect(result.details.some((d) => d.startsWith("Aborting cron"))).toBe(false)
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
