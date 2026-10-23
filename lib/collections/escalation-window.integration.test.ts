/**
 * Real-Postgres proof that an escalation run outside the dunning send window does
 * not lose the 60-DPD notice (PR #224 review, round 2): the DEFAULTED rule is not
 * applied at all outside 07:00-20:00 SAST, so the next in-window run flips the loan,
 * writes its note and sends the notice.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/escalation-window.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createSecondProduct, seedHoldLoan } from "@/lib/collections/dunning-holds.integration-fixture"
import { seedDefaultMessageTemplates } from "@/lib/messaging/default-templates"

const wire = vi.hoisted(() => ({ email: [] as string[], outside: false }))
vi.mock("@/lib/email/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/email/service")>()),
  sendEmail: vi.fn(async (a: { to: string }) => (wire.email.push(a.to), { ok: true, messageId: `em-${randomUUID()}`, providerOutcome: "ACCEPTED" })),
}))
vi.mock("@/lib/whatsapp-cloud", async (orig) => ({
  ...(await orig<typeof import("@/lib/whatsapp-cloud")>()),
  sendWhatsAppCloudMessage: vi.fn(async () => ({ ok: true, messageId: `wamid-${randomUUID()}` })),
}))
vi.mock("@/lib/integrations/bulksms", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/bulksms")>()),
  sendSms: vi.fn(async () => ({ ok: true, messageId: `sms-${randomUUID()}` })),
}))
vi.mock("@/lib/collections/send-window", async (orig) => ({
  ...(await orig<typeof import("@/lib/collections/send-window")>()),
  outsideDunningSendWindow: () => wire.outside,
}))

import { prisma } from "@/lib/prisma"
import { processEscalations } from "@/lib/collections/escalation"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let tenant: ChargesTenant

suite.sequential("escalation outside the send window (real Postgres)", { timeout: 120_000 }, () => {
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
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("defers the DEFAULTED rule whole at night, and the next in-window run flips, notes and sends the 60-DPD notice", async () => {
    const s = await seedHoldLoan(db, tenant, await createSecondProduct(db, tenant.tenantId), { name: "deferred default", held: false }, { inArrears: true })

    wire.outside = true
    const night = await processEscalations()
    const loan = await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { status: true, reference: true } })
    expect(loan.status, "not flipped at night").toBe("ACTIVE")
    expect(await db.loanNote.count({ where: { loanId: s.loanId, type: "escalation_default" } })).toBe(0)
    expect(await db.sendReservation.count({ where: { key: `escalation:${s.loanId}:escalation_default` } })).toBe(0)
    expect(night.details).toContainEqual(expect.stringContaining(`Deferred ${loan.reference} escalation_default`))
    expect(wire.email).not.toContain(s.email)

    wire.outside = false
    await processEscalations()
    expect((await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { status: true } })).status).toBe("DEFAULTED")
    expect(await db.loanNote.count({ where: { loanId: s.loanId, type: "escalation_default" } })).toBe(1)
    expect(wire.email.filter((e) => e === s.email), "the 60-DPD notice goes, once").toHaveLength(1)
  })
})
