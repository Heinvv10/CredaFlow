/**
 * Real-Postgres proof that the dunning holds (lib/collections/dunning-holds.ts)
 * keep a held loan out of BOTH reminder crons' real queries, and that a normal
 * ACTIVE loan still gets its reminder. The sends are stubbed; the loan
 * selection is not: a held loan is proven unreached by the absence of a send to
 * its (unique, synthetic) address, a normal loan by the presence of one, on the
 * specific leg (email, WhatsApp) each cron uses.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/dunning-holds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createChargesTenant, SCHEDULE_TOTAL, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { remindableLoanWhere } from "@/lib/collections/dunning-holds"
import {
  createSecondProduct, HOLD_CASES, parkOtherTenants, seedHoldLoan, type SeededHoldLoan,
} from "@/lib/collections/dunning-holds.integration-fixture"

const sends = vi.hoisted(() => ({ sms: [] as string[], whatsapp: [] as string[], email: [] as string[], cloudWhatsapp: [] as string[] }))

vi.mock("@/lib/integrations/bulksms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/bulksms")>()),
  sendSms: vi.fn(async (a: { to: string }) => (sends.sms.push(a.to), { ok: true })),
  sendWhatsApp: vi.fn(async (a: { to: string }) => (sends.whatsapp.push(a.to), { ok: true })),
}))
vi.mock("@/lib/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications")>()),
  triggerNotification: vi.fn(async () => undefined),
}))
vi.mock("@/lib/email/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/service")>()),
  sendEmail: vi.fn(async (a: { to: string }) => (sends.email.push(a.to), { ok: true, messageId: "m" })),
}))
vi.mock("@/lib/whatsapp/send-for-tenant", () => ({
  sendWhatsAppForTenant: vi.fn(async (a: { to: string }) => (sends.cloudWhatsapp.push(a.to), { ok: true })),
}))

import { prisma } from "@/lib/prisma"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { GET as paymentRemindersCron } from "@/app/api/cron/payment-reminders/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

let tenant: ChargesTenant
let restoreTenants: () => Promise<void> = async () => undefined
const seeded: SeededHoldLoan[] = []

suite.sequential("dunning holds on the real reminder queries (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    process.env.CRON_SECRET = "it-secret"
    process.env.NEXT_PUBLIC_TENANT_SLUG = (await db.tenant.findUniqueOrThrow({ where: { id: tenant.tenantId } })).slug
    delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
    delete process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS
    // Path A takes the first ACTIVE tenant it finds (fixed in a later PR): park the others.
    restoreTenants = await parkOtherTenants(db, tenant.tenantId)
    // Path B's WhatsApp leg is off until the tenant turns the channel on.
    await db.commsSettings.upsert({ where: { tenantId: tenant.tenantId }, create: { tenantId: tenant.tenantId, whatsappEnabled: true }, update: { whatsappEnabled: true } })
    const second = await createSecondProduct(db, tenant.tenantId)
    for (const c of HOLD_CASES) seeded.push(await seedHoldLoan(db, tenant, second, c))
  })
  afterAll(async () => {
    try {
      await db.$disconnect()
      await prisma.$disconnect()
    } finally {
      await restoreTenants()
    }
  })
  beforeEach(() => {
    sends.sms.length = sends.whatsapp.length = sends.email.length = sends.cloudWhatsapp.length = 0
  })

  it("path A (lib/collections/reminders.ts) sends the WhatsApp reminder to each normal loan and to no held one", async () => {
    await processPaymentReminders()

    expect(sends.whatsapp.length, "the harness must observe the WhatsApp leg").toBeGreaterThan(0)
    for (const s of seeded) {
      expect(sends.whatsapp.includes(s.whatsapp), `${s.name}: ${s.held ? "must be held" : "must be reminded"}`).toBe(!s.held)
    }
  })

  it("path B (app/api/cron/payment-reminders) sends the email and WhatsApp reminders to each normal loan and to no held one", async () => {
    const res = await paymentRemindersCron(new NextRequest("http://x/api/cron/payment-reminders", { headers: { "x-cron-secret": "it-secret" } }))
    expect(res.status).toBe(200)

    expect(sends.email.length, "the harness must observe the email leg").toBeGreaterThan(0)
    expect(sends.cloudWhatsapp.length, "the harness must observe the WhatsApp leg").toBeGreaterThan(0)
    for (const s of seeded) {
      const label = `${s.name}: ${s.held ? "must be held" : "must be reminded"}`
      expect(sends.email.includes(s.email), `${label} (email)`).toBe(!s.held)
      expect(sends.cloudWhatsapp.some((to) => to.startsWith(s.whatsapp.slice(1))), `${label} (WhatsApp)`).toBe(!s.held)
    }
  })

  it("the fragment itself, on the real tables, selects the normal loans and no held one", async () => {
    const rows = await db.loan.findMany({ where: { tenantId: tenant.tenantId, ...remindableLoanWhere() }, select: { id: true } })
    const ids = new Set(rows.map((r) => r.id))
    for (const s of seeded) expect(ids.has(s.loanId), s.name).toBe(!s.held)
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
