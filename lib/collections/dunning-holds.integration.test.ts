/**
 * Real-Postgres proof that the dunning holds (lib/collections/dunning-holds.ts)
 * keep a held loan out of the reminder cron's real query, and that a normal
 * ACTIVE loan still gets its reminder. The sends are stubbed; the loan
 * selection is not: a held loan is proven unreached by the absence of a send to
 * its (unique, synthetic) address, a normal loan by the presence of one.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/dunning-holds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { createChargesTenant, SCHEDULE_TOTAL, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { remindableLoanWhere } from "@/lib/collections/dunning-holds"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"
import {
  createSecondProduct, HOLD_CASES, seedHoldLoan, type SeededHoldLoan,
} from "@/lib/collections/dunning-holds.integration-fixture"

const sends = vi.hoisted(() => ({
  sms: [] as string[], whatsapp: [] as string[], email: [] as string[],
  /** Lets a test change the world in the middle of a cron run; returns true once it has acted (it then runs no more). */
  onSend: null as null | ((to: string) => Promise<boolean>),
}))
const tripWire = async (to: string) => {
  if (await sends.onSend?.(to)) sends.onSend = null
}

vi.mock("@/lib/integrations/bulksms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/bulksms")>()),
  sendSms: vi.fn(async (a: { to: string }) => (sends.sms.push(a.to), { ok: true })),
  sendWhatsApp: vi.fn(async (a: { to: string }) => (sends.whatsapp.push(a.to), await tripWire(a.to), { ok: true })),
}))
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async () => undefined),
}))
vi.mock("@/lib/email/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/service")>()),
  sendEmail: vi.fn(async (a: { to: string }) => (sends.email.push(a.to), await tripWire(a.to), { ok: true, messageId: "m" })),
}))

import { prisma } from "@/lib/prisma"
import { processPaymentReminders } from "@/lib/collections/reminders"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

let tenant: ChargesTenant
const seeded: SeededHoldLoan[] = []
let optedOut: SeededHoldLoan

suite.sequential("dunning holds on the real reminder queries (real Postgres)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
    await db.commsSettings.upsert({ where: { tenantId: tenant.tenantId }, create: { tenantId: tenant.tenantId, whatsappEnabled: true }, update: { whatsappEnabled: true } })
    // The email leg goes through sendMessage on every path: it needs the tenant's
    // email provider and the seeded `payment_reminder_email` template.
    await db.emailConfig.create({
      data: { tenantId: tenant.tenantId, provider: "IMAP_SMTP", fromName: "Synthetic lender", fromAddress: "sender@synthetic.invalid", smtpHost: "smtp.synthetic.invalid", smtpUser: "synthetic", smtpPass: "synthetic", active: true },
    })
    await seedDefaultMessageTemplates(db, tenant.tenantId, "Acme Lending")
    const second = await createSecondProduct(db, tenant.tenantId)
    for (const c of HOLD_CASES) seeded.push(await seedHoldLoan(db, tenant, second, c))
    // Not held, but the borrower has revoked service comms on email.
    optedOut = await seedHoldLoan(db, tenant, second, { name: "opted out of email", held: false })
    await db.contactConsent.create({
      data: { tenantId: tenant.tenantId, contactId: optedOut.contactId, channel: "EMAIL", purpose: "SERVICE_COMMS", status: "REVOKED", source: "EMAIL_LIST_UNSUBSCRIBE" },
    })
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })
  beforeEach(() => {
    sends.sms.length = sends.whatsapp.length = sends.email.length = 0
    sends.onSend = null
  })

  it("the reminders cron (lib/collections/reminders.ts) sends the WhatsApp and email reminders to each normal loan and to no held one", async () => {
    await processPaymentReminders()

    expect(sends.whatsapp.length, "the harness must observe the WhatsApp leg").toBeGreaterThan(0)
    for (const s of seeded) {
      expect(sends.whatsapp.includes(s.whatsapp), `${s.name}: ${s.held ? "must be held" : "must be reminded"}`).toBe(!s.held)
    }

    // The 7-day email leg goes through sendMessage (consent, holds, Message.dunning): each
    // normal loan is emailed once, a held loan never, an opted-out borrower gets nothing.
    expect(sends.email.length, "the harness must observe the email leg").toBeGreaterThan(0)
    for (const s of seeded) {
      expect(sends.email.filter((to) => to === s.email), `${s.name}: ${s.held ? "must be held" : "must be emailed once"}`).toHaveLength(s.held ? 0 : 1)
    }
    expect(sends.email.filter((to) => to === optedOut.email), "an opted-out email address is not sent to").toHaveLength(0)
    // ...while that borrower's other channel is unaffected: consent is per channel.
    expect(sends.whatsapp).toContain(optedOut.whatsapp)

    const messages = await db.message.findMany({ where: { tenantId: tenant.tenantId, channel: "EMAIL" }, select: { dunning: true, status: true } })
    expect(messages.length).toBeGreaterThan(0)
    expect(messages.every((m) => m.dunning), "email reminders are dunning messages").toBe(true)
  })

  it("the fragment itself, on the real tables, selects the normal loans and no held one", async () => {
    const rows = await db.loan.findMany({ where: { tenantId: tenant.tenantId, ...remindableLoanWhere() }, select: { id: true } })
    const ids = new Set(rows.map((r) => r.id))
    for (const s of seeded) expect(ids.has(s.loanId), s.name).toBe(!s.held)
  })

  // The loans are selected once at the start of a run; a notice recorded during it must stop the later sends.
  describe("a debt-review notice recorded mid-run", () => {
    const record = (loanId: string) => db.loan.update({ where: { id: loanId }, data: { debtReviewNoticeAt: new Date("2026-10-01T00:00:00+02:00") } })
    // Clean loans never need the second product (it is for the sibling case).
    const freshLoans = () => Promise.all([0, 1, 2].map((i) => seedHoldLoan(db, tenant, tenant.productId, { name: `mid-run ${i}`, held: false })))

    it("after the first send, the remaining loans of the run are not reminded", async () => {
      const fresh = await freshLoans()
      sends.onSend = async (to) => {
        if (!fresh.some((f) => f.whatsapp === to)) return false
        for (const f of fresh) if (f.whatsapp !== to) await record(f.loanId)
        return true
      }
      await processPaymentReminders()
      expect(sends.whatsapp.filter((to) => fresh.some((f) => f.whatsapp === to))).toHaveLength(1)
    })
  })

  // The loans are selected ACTIVE at the start of a run; one that stops being ACTIVE since (dpd-update defaulting it
  // at 90 DPD, a write-off, a settlement) must not be reminded: the per-send recheck is status-aware too.
  describe("a loan that stops being ACTIVE mid-run", () => {
    it("is not reminded after that: the remaining loans of the run are skipped", async () => {
      const fresh = await Promise.all([0, 1, 2].map((i) => seedHoldLoan(db, tenant, tenant.productId, { name: `status mid-run ${i}`, held: false })))
      sends.onSend = async (to) => {
        if (!fresh.some((f) => f.whatsapp === to)) return false
        for (const f of fresh) if (f.whatsapp !== to) await db.loan.update({ where: { id: f.loanId }, data: { status: "DEFAULTED" } })
        return true
      }
      await processPaymentReminders()
      expect(sends.whatsapp.filter((to) => fresh.some((f) => f.whatsapp === to))).toHaveLength(1)
    })
  })

  it("selects an entity-borrower loan (no client), which the client clauses must not exclude", async () => {
    const id = randomUUID().replaceAll("-", "").slice(0, 12)
    const entity = await db.businessEntity.create({
      data: { tenantId: tenant.tenantId, type: "COMPANY", legalName: "Hold Test (Pty) Ltd", registrationNumber: `2026/${id}/07` },
    })
    const app = await db.loanApplication.create({
      data: { tenantId: tenant.tenantId, reference: `APP-E-${id}`, entityId: entity.id, productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 31 },
    })
    const loan = await db.loan.create({
      data: {
        tenantId: tenant.tenantId, reference: `LN-E-${id}`, applicationId: app.id, entityId: entity.id, productId: tenant.productId,
        principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: SCHEDULE_TOTAL, outstandingPrincipal: 200_000,
        startDate: new Date(), maturityDate: new Date(Date.now() + 31 * 86_400_000), interestRatePm: 0.05, interestModel: "FLAT", status: "ACTIVE",
      },
    })
    const rows = await db.loan.findMany({ where: { tenantId: tenant.tenantId, ...remindableLoanWhere() }, select: { id: true } })
    expect(rows.map((r) => r.id)).toContain(loan.id)
  })
})
