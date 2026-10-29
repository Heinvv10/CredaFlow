/**
 * Real-Postgres proof of the minute sweep's limits: no alert address, hand-offs
 * too old to alert, chats no longer waiting on anyone, and expiry batches. The
 * hourly email cap is in handoff-caps.integration.test.ts.
 * The email itself is mocked (see alert.test.ts).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/handoff-sweep-limits.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { runWithTenant } from "@/lib/tenant-scope"

const m = vi.hoisted(() => ({ alert: vi.fn() }))
vi.mock("./alert", async (orig) => ({ ...(await orig<object>()), sendChatAlertEmail: m.alert }))

import { setConversationStatus } from "@/lib/inbox/thread-actions"
import { sweepHandoffs } from "./handoff-sweep"
import { recordAssistantReply, startChat } from "./store"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("sweepHandoffs: limits", () => {
  const db = new PrismaClient()
  const tenants: string[] = []
  // Tuesday 12:00 SAST: inside the default hours. 22:00 SAST: outside them.
  const open = new Date("2026-09-29T10:00:00Z")
  const afterHours = new Date("2026-09-29T20:00:00Z")
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)
  const MIN = 60_000
  const TO = "team@test.invalid"

  /** The sweep reads every hand-off of a tenant, so each test gets a tenant of its own. */
  async function tenant(chatAlertEmail: string | null = TO) {
    const id = `tenant_web_sweeplim${tenants.length}_${token}`
    await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat sweep limits IT", domain: null } })
    await db.commsSettings.create({ data: { tenantId: id, chatAlertEmail } })
    tenants.push(id)
    return id
  }
  /** Handed off by the bot in hours at `open` (waiting), or after hours (born timed out). */
  async function handedOff(tenantId: string, at = open) {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550002", email: `${randomUUID()}@test.invalid` }, now: at })
    await recordAssistantReply({ tenantId, conversationId: r.conversationId, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: at })
    return r.conversationId
  }
  const sweep = (tenantId: string, now: Date) => runWithTenant(tenantId, () => sweepHandoffs(tenantId, now))
  const row = (conversationId: string) => db.websiteChatHandoff.findUnique({ where: { conversationId } })

  beforeEach(() => {
    vi.clearAllMocks()
    m.alert.mockResolvedValue("sent")
  })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where }) // cascades WebsiteChatHandoff
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await purgeAuditRowsForTest(db, where) // AuditLog is append-only and its user FK no longer SETs NULL
    await db.user.deleteMany({ where })
    await db.commsSettings.deleteMany({ where })
    await db.tenant.deleteMany({ where: { id: { in: tenants } } })
    await db.$disconnect()
  })

  it("with no alert address the email step writes nothing at all; once one is set the alert still goes out", async () => {
    for (const address of [null, "", "   "]) {
      const t = await tenant(address)
      const id = await handedOff(t, afterHours)
      const before = await row(id)
      for (let run = 1; run <= 2; run++) expect(await sweep(t, plus(afterHours, run * 6 * MIN))).toEqual({ expired: 0, emailed: 0, failed: 0, released: 0 })
      expect(m.alert).not.toHaveBeenCalled()
      // No claim was taken: the counter and the lease stamp are exactly as the hand-off left them.
      expect(await row(id)).toEqual(before)
      expect(before).toMatchObject({ alertEmailSentAt: null, alertAttempts: 0 })

      await db.commsSettings.update({ where: { tenantId: t }, data: { chatAlertEmail: TO } })
      const now = plus(afterHours, 20 * MIN)
      expect(await sweep(t, now)).toMatchObject({ emailed: 1 })
      expect(m.alert.mock.calls).toEqual([[{ tenantId: t, conversationId: id, to: TO, now }]])
      m.alert.mockClear()
    }
  })

  it("hand-offs that timed out more than 24 hours ago are never emailed, however many there are when an address is first set", async () => {
    const t = await tenant(null)
    const old = new Date("2026-09-15T20:00:00Z")
    const stale: string[] = []
    for (let i = 0; i < 45; i++) stale.push(await handedOff(t, plus(old, i * 1000)))
    // The sweep ran all along; with no address it sent nothing.
    await sweep(t, plus(old, MIN))
    const now = new Date("2026-09-29T20:00:00Z")
    const justInside = await handedOff(t, plus(now, -24 * 60 * MIN))
    const justOutside = await handedOff(t, plus(now, -24 * 60 * MIN - 1000))

    await db.commsSettings.update({ where: { tenantId: t }, data: { chatAlertEmail: TO } })
    for (let run = 0; run < 4; run++) await sweep(t, plus(now, run * 1000))
    expect(m.alert.mock.calls.map(([a]) => a.conversationId)).toEqual([justInside])
    for (const id of [...stale, justOutside]) expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 0 })
  }, 120_000)

  it("a hand-off from two days ago that the sweep only now times out is never emailed", async () => {
    const t = await tenant()
    const now = plus(open, 2 * 24 * 60 * MIN)
    // In hours, so it waits; nothing ran since (the cron was down), so this run times it out.
    const old = await handedOff(t, plus(open, 0))
    const fresh = await handedOff(t, plus(now, -10 * MIN))
    expect(await sweep(t, now)).toEqual({ expired: 2, emailed: 1, failed: 0, released: 0 })
    expect(await row(old)).toMatchObject({ timedOutAt: now, alertEmailSentAt: null, alertAttempts: 0 })
    expect(m.alert.mock.calls.map(([a]) => a.conversationId)).toEqual([fresh])
  })

  it("a timed-out chat staff moved out of the wait without joining (called back, then OPEN or PENDING_CUSTOMER) is not emailed", async () => {
    const t = await tenant()
    const actor = await db.user.create({ data: { tenantId: t, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x", role: "ADMIN" } })
    const first = await handedOff(t, afterHours)
    const [opened, pending, waiting] = [await handedOff(t, plus(afterHours, 1000)), await handedOff(t, plus(afterHours, 2000)), await handedOff(t, plus(afterHours, 3000))]
    for (const [id, status] of [[opened, "OPEN"], [pending, "PENDING_CUSTOMER"]] as const) {
      await runWithTenant(t, () => setConversationStatus({ tenantId: t, conversationId: id, status, actorUserId: actor.id }))
    }
    // Moved while the first chat's email is being sent: the claim checks the status too.
    m.alert.mockImplementationOnce(async () => {
      await runWithTenant(t, () => setConversationStatus({ tenantId: t, conversationId: waiting, status: "OPEN", actorUserId: actor.id }))
      return "sent"
    })
    expect(await sweep(t, plus(afterHours, MIN))).toEqual({ expired: 0, emailed: 1, failed: 0, released: 0 })
    expect(m.alert.mock.calls.map(([a]) => a.conversationId)).toEqual([first])
    for (const id of [opened, pending, waiting]) expect(await row(id)).toMatchObject({ alertEmailSentAt: null, alertAttempts: 0 })
  })

  it("times out at most 200 hand-offs a run, oldest first; the next run takes the rest", async () => {
    const t = await tenant(null)
    const ids = Array.from({ length: 201 }, (_, i) => `conv_due_${String(i).padStart(3, "0")}_${token}`)
    await db.contact.createMany({ data: ids.map((id) => ({ id: `contact_${id}`, tenantId: t, status: "LEAD" as const, firstSeenChannel: "CHATBOT" as const })) })
    await db.conversation.createMany({ data: ids.map((id) => ({ id, tenantId: t, contactId: `contact_${id}`, channel: "CHATBOT" as const, status: "PENDING_INTERNAL" as const })) })
    // The first created is the newest: insert order must not be what decides.
    await db.websiteChatHandoff.createMany({ data: ids.map((id, i) => ({ tenantId: t, conversationId: id, handedOffAt: plus(open, (i === 0 ? 300 : i) * 1000) })) })
    const now = plus(open, 60 * MIN)
    expect(await sweep(t, now)).toMatchObject({ expired: 200 })
    expect(await db.websiteChatHandoff.findMany({ where: { tenantId: t, timedOutAt: null }, select: { conversationId: true } })).toEqual([{ conversationId: ids[0] }])
    expect(await sweep(t, now)).toMatchObject({ expired: 1 })
  }, 60_000)

  it("hand-offs that can never time out take no place in the expiry batch", async () => {
    const t = await tenant()
    // 200 waits nobody will ever expire: the chat was closed, reopened by hand, or is held by staff.
    const staff = await db.user.create({ data: { tenantId: t, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x" } })
    const dead = Array.from({ length: 200 }, (_, i) => ({ id: `conv_dead_${String(i).padStart(3, "0")}_${token}`, kind: i % 3 }))
    // One open thread per contact (unique index), so each chat gets a contact of its own.
    await db.contact.createMany({ data: dead.map((d) => ({ id: `contact_${d.id}`, tenantId: t, status: "LEAD" as const, firstSeenChannel: "CHATBOT" as const })) })
    await db.conversation.createMany({ data: dead.map((d) => ({
      id: d.id, tenantId: t, contactId: `contact_${d.id}`, channel: "CHATBOT" as const,
      status: d.kind === 0 ? "CLOSED" as const : d.kind === 1 ? "OPEN" as const : "PENDING_INTERNAL" as const,
      closedAt: d.kind === 0 ? open : null, assigneeId: d.kind === 2 ? staff.id : null,
    })) })
    await db.websiteChatHandoff.createMany({ data: dead.map((d, i) => ({ tenantId: t, conversationId: d.id, handedOffAt: plus(open, i * 1000) })) })
    // Handed off after all of them: the visitor closed the tab, so only the sweep can time it out.
    const live = await handedOff(t, plus(open, 10 * MIN))

    const now = plus(open, 60 * MIN)
    expect(await sweep(t, now)).toEqual({ expired: 1, emailed: 1, failed: 0, released: 0 })
    expect(await row(live)).toMatchObject({ timedOutAt: now, alertEmailSentAt: now })
    expect(await db.websiteChatHandoff.count({ where: { tenantId: t, timedOutAt: null } })).toBe(200)
  }, 60_000)
})
