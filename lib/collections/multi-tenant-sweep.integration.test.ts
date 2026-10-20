/**
 * Real-Postgres proof that the three nightly dunning jobs (dpd-update,
 * escalations, reminders) sweep EVERY ACTIVE tenant, each inside its own tenant
 * frame, and keep the tenants apart. Only the provider sends are stubbed; the
 * tenant lookup, the frame, the loan queries and (for escalation) the real
 * triggerNotification run unmocked, so the 60-DPD DEFAULTED notice has to find
 * its client under the real tenant-scope extension.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/multi-tenant-sweep.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { createSecondProduct, seedHoldLoan, type SeededHoldLoan } from "@/lib/collections/dunning-holds.integration-fixture"

interface Sent { to: string; body: string }
const sent = vi.hoisted(() => ({ whatsapp: [] as { to: string; body: string }[], email: [] as { to: string; body: string }[], delayMs: 0 }))

vi.mock("@/lib/integrations/bulksms", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/integrations/bulksms")>()),
  sendSms: vi.fn(async () => ({ ok: true })),
  sendWhatsApp: vi.fn(async (a: { to: string; message: string }) => {
    // A slow provider is what lets a second run get past the "already sent today" check.
    if (sent.delayMs) await new Promise((resolve) => setTimeout(resolve, sent.delayMs))
    sent.whatsapp.push({ to: a.to, body: a.message })
    return { ok: true }
  }),
}))
vi.mock("@/lib/email/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/service")>()),
  sendEmail: vi.fn(async (a: { to: string; subject?: string; html?: string; text?: string }) => (
    sent.email.push({ to: a.to, body: `${a.subject ?? ""} ${a.html ?? ""} ${a.text ?? ""}` }), { ok: true, messageId: "m" }
  )),
}))
vi.mock("@/lib/whatsapp/send-for-tenant", () => ({
  sendWhatsAppForTenant: vi.fn(async (a: { to: string; message?: string }) => (sent.whatsapp.push({ to: a.to, body: a.message ?? "" }), { ok: true })),
}))

import { prisma } from "@/lib/prisma"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { processEscalations } from "@/lib/collections/escalation"
import { GET as dpdUpdateCron } from "@/app/api/cron/dpd-update/route"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

const BRAND = { a: "Acme Lending", b: "Beta Credit Co" }
let a: ChargesTenant
let b: ChargesTenant
let remindA: SeededHoldLoan
let remindB: SeededHoldLoan
let heldA: SeededHoldLoan
let heldB: SeededHoldLoan
let arrearsA: SeededHoldLoan
let arrearsB: SeededHoldLoan

const delivered = (list: Sent[], to: string) => list.filter((s) => s.to.includes(to.replace(/^\+/, "")))

suite.sequential("nightly dunning jobs sweep every ACTIVE tenant (real Postgres)", { timeout: 120_000 }, () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = "it-secret"
    delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
    delete process.env.MESSAGING_NEW_SEND_NOTIF_LOAN_OVERDUE
    a = await createChargesTenant(db, false)
    b = await createChargesTenant(db, false)
    // Same synthetic identity columns by default: give B its own name so a message that crosses tenants shows.
    await db.tenantConfig.update({ where: { tenantId: a.tenantId }, data: { brandName: BRAND.a, legalName: `${BRAND.a} (Pty) Ltd` } })
    await db.tenantConfig.update({ where: { tenantId: b.tenantId }, data: { brandName: BRAND.b, legalName: `${BRAND.b} (Pty) Ltd` } })
    // dpd-update's default tenant is A: the sweep must still reach B.
    process.env.NEXT_PUBLIC_TENANT_SLUG = (await db.tenant.findUniqueOrThrow({ where: { id: a.tenantId } })).slug
    for (const t of [a, b]) {
      await db.commsSettings.upsert({ where: { tenantId: t.tenantId }, create: { tenantId: t.tenantId, whatsappEnabled: true }, update: { whatsappEnabled: true } })
    }
    // A has an email provider, B does not; neither was created with the default templates.
    await db.emailConfig.create({
      data: { tenantId: a.tenantId, provider: "IMAP_SMTP", fromName: "Synthetic lender", fromAddress: "sender@synthetic.invalid", smtpHost: "smtp.synthetic.invalid", smtpUser: "synthetic", smtpPass: "synthetic", active: true },
    })
    const secondA = await createSecondProduct(db, a.tenantId)
    const secondB = await createSecondProduct(db, b.tenantId)
    remindA = await seedHoldLoan(db, a, secondA, { name: "remind A", held: false })
    remindB = await seedHoldLoan(db, b, secondB, { name: "remind B", held: false })
    heldA = await seedHoldLoan(db, a, secondA, { name: "held A", deceased: true, held: true })
    heldB = await seedHoldLoan(db, b, secondB, { name: "held B", stage: "ATTORNEY_REFERRED", held: true })
    arrearsA = await seedHoldLoan(db, a, secondA, { name: "arrears A", held: false }, { inArrears: true })
    arrearsB = await seedHoldLoan(db, b, secondB, { name: "arrears B", held: false }, { inArrears: true })
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("reminders: each tenant's normal loan is reminded once, about its own loan, and no held loan is", async () => {
    sent.whatsapp.length = 0
    sent.email.length = 0
    const templates = (tenantId: string) => db.messageTemplate.count({ where: { tenantId, key: "payment_reminder_email" } })
    expect([await templates(a.tenantId), await templates(b.tenantId)], "tenants predating the template").toEqual([0, 0])

    const result = await processPaymentReminders()

    // The run seeds the default templates every tenant lacks, then emails where the tenant can send email.
    expect([await templates(a.tenantId), await templates(b.tenantId)]).toEqual([1, 1])
    expect(delivered(sent.email, remindA.email), "A has an email provider: its borrower is emailed").toHaveLength(1)
    expect(delivered(sent.email, remindB.email), "B has none: the leg is skipped, not sent").toHaveLength(0)
    expect(result.warnings, "B's skipped email leg is a tenant warning").toBeGreaterThanOrEqual(1)

    for (const [seeded, otherSeeded] of [[remindA, remindB], [remindB, remindA]] as const) {
      const got = delivered(sent.whatsapp, seeded.whatsapp)
      expect(got, `${seeded.name} must be reminded exactly once`).toHaveLength(1)
      const [own, other] = await Promise.all([seeded, otherSeeded].map((s) => db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { reference: true } })))
      expect(got[0].body).toContain(own.reference)
      expect(got[0].body).not.toContain(other.reference)
    }
    for (const seeded of [heldA, heldB]) expect(delivered(sent.whatsapp, seeded.whatsapp), seeded.name).toHaveLength(0)
  })

  it("escalations: both tenants' loans are defaulted and both borrowers get the 60-DPD notice, in their own lender's name", async () => {
    sent.email.length = 0
    const result = await processEscalations()
    const refs = (await db.loan.findMany({ where: { id: { in: [arrearsA.loanId, arrearsB.loanId] } }, select: { reference: true } })).map((l) => l.reference)
    expect(result.details.filter((d) => d.startsWith("Error") && refs.some((r) => d.includes(r))).join("\n"), "no rule may throw for these loans").toBe("")

    for (const [seeded, tenant, own, other] of [[arrearsA, a, BRAND.a, BRAND.b], [arrearsB, b, BRAND.b, BRAND.a]] as const) {
      const loan = await db.loan.findUniqueOrThrow({ where: { id: seeded.loanId }, select: { status: true } })
      expect(loan.status, `${seeded.name} must be DEFAULTED`).toBe("DEFAULTED")
      const note = await db.loanNote.findFirst({ where: { loanId: seeded.loanId, type: "escalation_default" } })
      expect(note?.tenantId, `${seeded.name}: the note belongs to the loan's own tenant`).toBe(tenant.tenantId)

      // The rule fires the notification without awaiting it (escalation.ts), so it lands just after the run returns.
      await vi.waitFor(() => expect(delivered(sent.email, seeded.email), `${seeded.name}: the DEFAULTED notice must reach the borrower`).toHaveLength(1), { timeout: 5000 })
      const got = delivered(sent.email, seeded.email)
      expect(got[0].body).toContain(own)
      expect(got[0].body).not.toContain(other)
    }
  })

  // The backstop under the run claim: a takeover can overlap a runner that only lost its heartbeat,
  // and both then pass the "already sent today" check before either has written its marker.
  it("two runs racing on the same day send each message and each notice once", async () => {
    const [remindFreshA, remindFreshB, defaultFreshA, defaultFreshB] = await Promise.all([
      seedHoldLoan(db, a, a.productId, { name: "race remind A", held: false }),
      seedHoldLoan(db, b, b.productId, { name: "race remind B", held: false }),
      seedHoldLoan(db, a, a.productId, { name: "race default A", held: false }, { inArrears: true }),
      seedHoldLoan(db, b, b.productId, { name: "race default B", held: false }, { inArrears: true }),
    ])
    sent.whatsapp.length = 0
    sent.email.length = 0
    sent.delayMs = 150
    let emailsBeforeEscalations = 0
    try {
      await Promise.all([processPaymentReminders(), processPaymentReminders()])
      emailsBeforeEscalations = sent.email.length
      await Promise.all([processEscalations(), processEscalations()])
      await new Promise((resolve) => setTimeout(resolve, 600))
    } finally {
      sent.delayMs = 0
    }

    for (const s of [remindFreshA, remindFreshB]) expect(delivered(sent.whatsapp, s.whatsapp), `${s.name}: reminded once`).toHaveLength(1)
    // These loans are also pre-due, so they get a reminder email; the escalation phase's emails are the notices.
    const notices = sent.email.slice(emailsBeforeEscalations)
    for (const s of [defaultFreshA, defaultFreshB]) expect(delivered(notices, s.email), `${s.name}: one DEFAULTED notice`).toHaveLength(1)
  })

  // A lost run is retried the same day (lib/ops/cron-run-claim.ts), so a repeat must be harmless.
  it("a second run the same day sends nothing new and writes nothing twice", async () => {
    sent.whatsapp.length = 0
    sent.email.length = 0
    const notes = () => db.loanNote.count({ where: { loanId: { in: [remindA.loanId, remindB.loanId, arrearsA.loanId, arrearsB.loanId] } } })
    const before = await notes()

    await processPaymentReminders()
    await processEscalations()
    await new Promise((resolve) => setTimeout(resolve, 300))

    expect(delivered(sent.whatsapp, remindA.whatsapp).concat(delivered(sent.whatsapp, remindB.whatsapp))).toHaveLength(0)
    expect(delivered(sent.email, arrearsA.email).concat(delivered(sent.email, arrearsB.email))).toHaveLength(0)
    expect(await notes()).toBe(before)
  })

  // Last: it recomputes DPD for every tenant, which resets the arrears the escalation case seeds by hand.
  it("dpd-update recomputes the arrears of both tenants' loans", async () => {
    const [la, lb] = await Promise.all([createChargesLoan(db, a), createChargesLoan(db, b)])
    const res = await dpdUpdateCron(new NextRequest("http://x/api/cron/dpd-update", { headers: { "x-cron-secret": "it-secret" } }))
    // Rows other suites left in a shared database can fail their own tenant's pass: only these two matter here.
    const body = (await res.json()) as { perTenant: Array<{ tenantId: string; error?: string }> }
    for (const t of [a, b]) {
      const entry = body.perTenant.find((p) => p.tenantId === t.tenantId)
      expect(entry, `${t.tenantId} must be swept`).toBeDefined()
      expect(entry?.error, `${t.tenantId} must not fail`).toBeUndefined()
    }
    const rows = await db.loan.findMany({ where: { id: { in: [la.loanId, lb.loanId] } }, select: { id: true, tenantId: true, daysInArrears: true, arrearsAmount: true } })
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.daysInArrears, `${row.tenantId} must have its DPD recomputed`).toBeGreaterThan(0)
      expect(row.arrearsAmount, `${row.tenantId} must have its arrears recomputed`).toBeGreaterThan(0)
    }
  })
})
