/**
 * Real-Postgres proof that the dunning holds (lib/collections/dunning-holds.ts)
 * keep a held loan out of BOTH reminder crons' real queries, and that a normal
 * ACTIVE loan still gets its reminder. The sends are stubbed; the loan
 * selection is not: a held loan is proven unreached by the absence of a send to
 * its (unique, synthetic) address, a normal loan by the presence of one.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/collections/dunning-holds.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import type { LoanStatus, CollectionsStage } from "@prisma/client"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { createChargesTenant, SCHEDULE_TOTAL, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { sastStartOfDay } from "@/lib/date/sast"
import { remindableLoanWhere } from "@/lib/collections/dunning-holds"
import {
  blockContactsForDeceasedClient,
  DECEASED_CONTACT_BLOCK_REASON,
  releaseContactsForRevivedClient,
} from "@/lib/clients/deceased-contacts"
import { evaluateEligibility } from "@/lib/messaging/eligibility"

const sends = vi.hoisted(() => ({
  sms: [] as string[],
  whatsapp: [] as string[],
  email: [] as string[],
  cloudWhatsapp: [] as string[],
  tenantId: "",
}))

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

interface Case {
  name: string
  status?: LoanStatus
  stage?: CollectionsStage
  arrangement?: "ACTIVE" | "KEPT"
  deceased?: boolean
  debtReview?: boolean
  held: boolean
}

const CASES: Case[] = [
  { name: "normal ACTIVE", held: false },
  { name: "ACTIVE with a KEPT arrangement (finished, not a hold)", arrangement: "KEPT", held: false },
  { name: "WRITTEN_OFF", status: "WRITTEN_OFF", held: true },
  { name: "PENDING_WRITE_OFF", status: "PENDING_WRITE_OFF", held: true },
  { name: "DEFAULTED", status: "DEFAULTED", held: true },
  { name: "ACTIVE at stage WRITTEN_OFF", stage: "WRITTEN_OFF", held: true },
  { name: "ACTIVE at stage ATTORNEY_REFERRED", stage: "ATTORNEY_REFERRED", held: true },
  { name: "ACTIVE at stage PAYMENT_ARRANGEMENT", stage: "PAYMENT_ARRANGEMENT", held: true },
  { name: "ACTIVE with an ACTIVE PaymentArrangement row", arrangement: "ACTIVE", held: true },
  { name: "deceased client", deceased: true, held: true },
  { name: "under debt review", debtReview: true, held: true },
]

interface Seeded extends Case { loanId: string; email: string; phone: string; whatsapp: string }

let tenant: ChargesTenant
let slug: string
const seeded: Seeded[] = []

// An address the case alone owns, so "was this loan reached" is a lookup.
const digits = (n: number) => `0${(7_000_000_000 + n).toString().slice(0, 9)}`

async function seedLoan(c: Case, n: number, dueInDays: number): Promise<Seeded> {
  const id = randomUUID().replaceAll("-", "").slice(0, 12)
  const email = `hold-${id}@client.invalid`
  const phone = `+27${digits(n).slice(1)}`
  const whatsapp = `+27${digits(n + 500).slice(1)}`
  const client = await db.client.create({
    data: {
      tenantId: tenant.tenantId, idNumber: `91${id.slice(0, 11)}`, firstName: "Hold", lastName: c.name.slice(0, 20),
      email, phone, whatsapp, deceasedAt: c.deceased ? new Date("2026-09-01T00:00:00Z") : null,
      deceasedReason: c.deceased ? "synthetic" : null,
    },
  })
  await db.contact.create({
    data: {
      tenantId: tenant.tenantId, clientId: client.id, status: "CLIENT", firstSeenChannel: "MANUAL",
      primaryEmail: email, primaryPhone: phone, primaryWaJid: `${whatsapp.slice(1)}@s.whatsapp.net`,
    },
  })
  const app = await db.loanApplication.create({
    data: { tenantId: tenant.tenantId, reference: `APP-${id}`, clientId: client.id, productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 31 },
  })
  const due = new Date(sastStartOfDay(new Date()).getTime() + dueInDays * 86_400_000)
  const loan = await db.loan.create({
    data: {
      tenantId: tenant.tenantId, reference: `LN-${id}`, applicationId: app.id, clientId: client.id, productId: tenant.productId,
      principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: SCHEDULE_TOTAL, outstandingPrincipal: 200_000,
      startDate: new Date(due.getTime() - 31 * 86_400_000), maturityDate: due, nextPaymentDate: due,
      interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6_900,
      status: c.status ?? "ACTIVE", collectionsStage: c.stage ?? "NONE",
      debtReviewNoticeAt: c.debtReview ? new Date("2026-10-01T00:00:00+02:00") : null,
    },
  })
  await db.repaymentSchedule.create({
    data: {
      tenantId: tenant.tenantId, loanId: loan.id, installmentNo: 1, dueDate: due, principalDue: 200_000,
      interestDue: 10_000, feesDue: 6_900, totalDue: SCHEDULE_TOTAL,
    },
  })
  if (c.arrangement) {
    await db.paymentArrangement.create({
      data: {
        tenantId: tenant.tenantId, loanId: loan.id, arrangementDate: new Date(), agreedAmount: 50_000,
        frequency: "MONTHLY", startDate: new Date(), endDate: new Date(Date.now() + 90 * 86_400_000), status: c.arrangement,
      },
    })
  }
  return { ...c, loanId: loan.id, email, phone, whatsapp }
}

async function seedAll(dueInDays: number) {
  seeded.length = 0
  for (const [i, c] of CASES.entries()) seeded.push(await seedLoan(c, i * 7 + dueInDays, dueInDays))
}

suite.sequential("dunning holds on the real reminder queries (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    slug = (await db.tenant.findUniqueOrThrow({ where: { id: tenant.tenantId } })).slug
    sends.tenantId = tenant.tenantId
    process.env.CRON_SECRET = "it-secret"
    process.env.NEXT_PUBLIC_TENANT_SLUG = slug
    delete process.env.MESSAGING_NEW_SEND_COLLECTIONS
    delete process.env.MESSAGING_NEW_SEND_PAYMENT_REMINDERS
    // Path A takes the first ACTIVE tenant it finds. Park every other one for
    // the run, and restore them after.
    await db.tenant.updateMany({ where: { id: { not: tenant.tenantId }, status: "ACTIVE" }, data: { status: "SUSPENDED" } })
  })
  afterAll(async () => {
    await db.tenant.updateMany({ where: { id: { not: tenant.tenantId }, status: "SUSPENDED" }, data: { status: "ACTIVE" } })
    await db.$disconnect()
    await prisma.$disconnect()
  })
  beforeEach(() => {
    sends.sms.length = sends.whatsapp.length = sends.email.length = sends.cloudWhatsapp.length = 0
  })

  it("path A (lib/collections/reminders.ts): reminds the normal loans and none of the held ones", async () => {
    await seedAll(7) // reminder_7d
    await processPaymentReminders()

    const reached = new Set([...sends.sms, ...sends.whatsapp])
    for (const s of seeded) {
      const wasReached = reached.has(s.phone) || reached.has(s.whatsapp)
      expect(wasReached, `${s.name}: ${s.held ? "must be held" : "must be reminded"}`).toBe(!s.held)
    }
    expect(seeded.filter((s) => !s.held).length).toBeGreaterThan(0)
  })

  it("path B (app/api/cron/payment-reminders): reminds the normal loans and none of the held ones", async () => {
    await seedAll(3) // 3-day courtesy reminder
    const res = await paymentRemindersCron(new NextRequest("http://x/api/cron/payment-reminders", { headers: { "x-cron-secret": "it-secret" } }))
    expect(res.status).toBe(200)

    const reached = new Set([...sends.email, ...sends.cloudWhatsapp])
    for (const s of seeded) {
      const wasReached = reached.has(s.email) || [...reached].some((r) => r.startsWith(s.whatsapp.slice(1)))
      expect(wasReached, `${s.name}: ${s.held ? "must be held" : "must be reminded"}`).toBe(!s.held)
    }
  })

  it("the fragment itself, on the real tables: selects the normal loans and no held one", async () => {
    const rows = await db.loan.findMany({ where: { tenantId: tenant.tenantId, ...remindableLoanWhere() }, select: { id: true } })
    const ids = new Set(rows.map((r) => r.id))
    for (const s of seeded) expect(ids.has(s.loanId), s.name).toBe(!s.held)
  })

  it("a recorded death blocks the Contact for every channel, and reversing it re-opens only that block", async () => {
    const [normal, other] = [seeded[0], seeded[1]]
    const clientOf = async (s: Seeded) => (await db.loan.findUniqueOrThrow({ where: { id: s.loanId }, select: { clientId: true } })).clientId!
    const contactOf = async (s: Seeded) => db.contact.findFirstOrThrow({ where: { tenantId: tenant.tenantId, clientId: await clientOf(s) } })

    // A Contact an operator blocked for fraud must survive the death being reversed.
    await db.contact.update({ where: { id: (await contactOf(other)).id }, data: { status: "BLOCKED", blockedReason: "fraud" } })

    expect(await blockContactsForDeceasedClient(db, { tenantId: tenant.tenantId, clientId: await clientOf(normal) })).toBe(1)
    expect(await blockContactsForDeceasedClient(db, { tenantId: tenant.tenantId, clientId: await clientOf(other) })).toBe(0)
    expect(await contactOf(normal)).toMatchObject({ status: "BLOCKED", blockedReason: DECEASED_CONTACT_BLOCK_REASON })
    expect((await contactOf(normal)).blockedAt).toBeInstanceOf(Date)
    // The send gate every channel runs (lib/messaging/eligibility.ts) refuses it.
    const gate = await evaluateEligibility(db as never,(await contactOf(normal)).id, "EMAIL", {
      tenantId: tenant.tenantId, key: "payment_reminder", category: "SERVICE", statutoryOverride: false,
    } as never)
    expect(gate).toEqual({ ok: false, reason: "BLOCKED" })

    expect(await releaseContactsForRevivedClient(db, { tenantId: tenant.tenantId, clientId: await clientOf(normal) })).toBe(1)
    expect(await releaseContactsForRevivedClient(db, { tenantId: tenant.tenantId, clientId: await clientOf(other) })).toBe(0)
    expect(await contactOf(normal)).toMatchObject({ status: "CLIENT", blockedAt: null, blockedReason: null })
    expect(await contactOf(other)).toMatchObject({ status: "BLOCKED", blockedReason: "fraud" })
  })

  it("selects an entity-borrower loan (no client), which the deceased clause must not exclude", async () => {
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
