/**
 * Real-Postgres proof of the two hourly caps on what a flood of hand-offs can send
 * staff: 30 conversations rung on the bell, 20 alert emails. Both count what was
 * actually sent (bell items, EmailLog rows), so a chat staff joined, which deletes
 * its hand-off row, still counts. The email itself is mocked; the mock writes the
 * EmailLog row sendEmail would, stamped with the sweep's clock.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/handoff-caps.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"

const m = vi.hoisted(() => ({ alert: vi.fn() }))
vi.mock("./alert", async (orig) => ({ ...(await orig<object>()), sendChatAlertEmail: m.alert }))

import { CHAT_ALERT_EMAIL_CATEGORY } from "./alert"
import { MAX_HANDOFF_BELLS_PER_HOUR, notifyStaffOfHandoff } from "./handoff"
import { sweepHandoffs } from "./handoff-sweep"
import { joinChat } from "./staff"
import { recordAssistantReply, startChat } from "./store"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("hand-off caps", () => {
  const db = new PrismaClient()
  const tenants: string[] = []
  // 22:00 SAST, outside the default hours: a hand-off is born timed out, so the sweep emails it at once.
  const afterHours = new Date("2026-09-29T20:00:00Z")
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)
  const MIN = 60_000
  const TO = "team@test.invalid"

  /** Each test gets a tenant of its own, with an alert address and one admin to ring. */
  async function tenant() {
    const id = `tenant_web_caps${tenants.length}_${token}`
    await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat caps IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    await db.commsSettings.create({ data: { tenantId: id, chatAlertEmail: TO } })
    const admin = await db.user.create({ data: { tenantId: id, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x", role: "ADMIN" } })
    tenants.push(id)
    return { t: id, admin: admin.id }
  }
  async function handedOff(tenantId: string, at: Date) {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550002", email: `${randomUUID()}@test.invalid` }, now: at })
    await recordAssistantReply({ tenantId, conversationId: r.conversationId, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: at })
    return r.conversationId
  }
  const many = async (tenantId: string, n: number, at: Date) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) ids.push(await handedOff(tenantId, plus(at, i * 1000)))
    return ids
  }
  const sweep = (tenantId: string, now: Date) => runWithTenant(tenantId, () => sweepHandoffs(tenantId, now))
  const emailed = () => m.alert.mock.calls.map(([a]) => a.conversationId)
  const bells = (entityId: string) => db.notification.count({ where: { entityId, type: "CHAT_HANDOFF" } })
  /** Bell items for `n` other chats, as notifyStaffOfHandoff would have written them `ago` ms back. */
  const rang = (tenantId: string, userIds: string[], n: number, ago: number) => db.notification.createMany({ data: Array.from({ length: n }, () => {
    const entityId = `conv_rang_${randomUUID()}`
    return userIds.map((userId) => ({ tenantId, userId, type: "CHAT_HANDOFF", title: "Website chat needs a person", entityType: "Conversation", entityId, createdAt: new Date(Date.now() - ago) }))
  }).flat() })

  beforeEach(() => {
    vi.clearAllMocks()
    m.alert.mockImplementation(async (a: { tenantId: string; conversationId: string; to: string; now: Date }) => {
      await db.emailLog.create({ data: { tenantId: a.tenantId, toAddress: a.to, subject: "Website chat not answered", bodyHtml: "x", category: CHAT_ALERT_EMAIL_CATEGORY, referenceId: a.conversationId, status: "SENT", createdAt: a.now } })
      return "sent"
    })
  })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await db.auditLog.deleteMany({ where })
    await db.notification.deleteMany({ where })
    await db.emailLog.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where }) // cascades WebsiteChatHandoff
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.commsSettings.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: { in: tenants } } })
    await db.tenant.deleteMany({ where: { id: { in: tenants } } })
    await db.$disconnect()
  })

  describe("alert emails: 20 an hour, counted from EmailLog", () => {
    it("the alert category is the one alert.ts sends with", () => {
      expect(CHAT_ALERT_EMAIL_CATEGORY).toBe("website_chat_alert")
    })

    it("sends 20, oldest timed out first; the rest wait for room and go out once the first ones are an hour old", async () => {
      const { t } = await tenant()
      const ids = await many(t, 22, afterHours)
      // Insert order must not be what decides: the first chat created becomes the newest time-out.
      await db.websiteChatHandoff.update({ where: { conversationId: ids[0] }, data: { timedOutAt: plus(afterHours, 30_000) } })
      const now = plus(afterHours, MIN)
      expect(await sweep(t, now)).toMatchObject({ emailed: 20 })
      expect(emailed()).toEqual(ids.slice(1, 21))
      for (const later of [plus(now, MIN), plus(now, 59 * MIN)]) expect(await sweep(t, later)).toMatchObject({ emailed: 0 })
      expect(m.alert).toHaveBeenCalledTimes(20)
      expect(await sweep(t, plus(now, 60 * MIN + 1000))).toMatchObject({ emailed: 2 })
      expect(emailed().slice(20)).toEqual([ids[21], ids[0]])
    }, 60_000)

    it("with 19 alerts logged this hour, one more goes out; one logged an hour and a second ago does not count", async () => {
      const { t } = await tenant()
      const ids = await many(t, 3, afterHours)
      const now = plus(afterHours, 30 * MIN)
      const log = (n: number, at: Date) => db.emailLog.createMany({ data: Array.from({ length: n }, () => ({ tenantId: t, toAddress: TO, subject: "s", bodyHtml: "x", category: CHAT_ALERT_EMAIL_CATEGORY, createdAt: at })) })
      await log(19, plus(now, -59 * MIN))
      await log(5, plus(now, -61 * MIN))
      // Other mail of the tenant is not alert mail.
      await db.emailLog.createMany({ data: Array.from({ length: 5 }, () => ({ tenantId: t, toAddress: TO, subject: "s", bodyHtml: "x", category: "statement", createdAt: now })) })
      expect(await sweep(t, now)).toMatchObject({ emailed: 1 })
      expect(emailed()).toEqual([ids[0]])
    }, 60_000)

    it("a minute with nothing to send never counts the mail log (EmailLog has no index); one with something to send does, once", async () => {
      const { t } = await tenant()
      const count = vi.spyOn(prisma.emailLog, "count")
      try {
        // No hand-off at all, then one still inside its wait: nothing is eligible.
        expect(await sweep(t, afterHours)).toMatchObject({ emailed: 0 })
        const waiting = await handedOff(t, new Date("2026-09-29T10:00:00Z"))
        expect(await sweep(t, new Date("2026-09-29T10:01:00Z"))).toMatchObject({ emailed: 0 })
        expect(count).not.toHaveBeenCalled()

        expect(await sweep(t, new Date("2026-09-29T10:03:00Z"))).toMatchObject({ expired: 1, emailed: 1 })
        expect(count).toHaveBeenCalledTimes(1)
        expect(emailed()).toEqual([waiting])
      } finally {
        count.mockRestore()
      }
    })

    it("past the cap (two runs overlapped) nothing goes out", async () => {
      const { t } = await tenant()
      await many(t, 23, afterHours)
      const now = plus(afterHours, MIN)
      await db.emailLog.createMany({ data: Array.from({ length: 21 }, () => ({ tenantId: t, toAddress: TO, subject: "s", bodyHtml: "x", category: CHAT_ALERT_EMAIL_CATEGORY, createdAt: now })) })
      expect(await sweep(t, now)).toMatchObject({ emailed: 0 })
      expect(m.alert).not.toHaveBeenCalled()
    }, 60_000)

    it("chats staff joined after their alert went out still count: the join deletes the hand-off row, not the mail", async () => {
      const { t, admin } = await tenant()
      const ids = await many(t, 20, afterHours)
      const now = plus(afterHours, MIN)
      expect(await sweep(t, now)).toMatchObject({ emailed: 20 })
      for (const id of ids) expect(await joinChat({ tenantId: t, conversationId: id, staffUserId: admin, now: plus(now, MIN) })).toEqual({ ok: true })
      expect(await db.websiteChatHandoff.count({ where: { tenantId: t } })).toBe(0)

      const late = await handedOff(t, plus(now, 2 * MIN))
      expect(await sweep(t, plus(now, 3 * MIN))).toMatchObject({ emailed: 0 })
      expect(await sweep(t, plus(now, 60 * MIN + 1000))).toMatchObject({ emailed: 1 })
      expect(emailed().at(-1)).toBe(late)
    }, 60_000)
  })

  describe("bell: 30 conversations an hour, counted from the bell items", () => {
    const now = () => new Date()

    it("the 30th conversation still rings, the 31st does not; the chat still waits in the inbox", async () => {
      expect(MAX_HANDOFF_BELLS_PER_HOUR).toBe(30)
      const { t, admin } = await tenant()
      const second = (await db.user.create({ data: { tenantId: t, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x", role: "ADMIN" } })).id
      // 29 conversations rang two people each (58 items, 29 conversations), and 10 more just outside the hour.
      await rang(t, [admin, second], 29, 59 * MIN)
      await rang(t, [admin], 10, 61 * MIN)
      // Other bell items of the hour (an @mention on another conversation) are not hand-offs.
      await db.notification.createMany({ data: Array.from({ length: 5 }, () => ({ tenantId: t, userId: admin, type: "COMMS_MENTION", title: "m", entityType: "Conversation", entityId: `conv_note_${randomUUID()}` })) })
      const thirtieth = await handedOff(t, now())
      await notifyStaffOfHandoff({ tenantId: t, conversationId: thirtieth, now: now() })
      expect(await bells(thirtieth)).toBe(2)

      const next = await handedOff(t, now())
      await notifyStaffOfHandoff({ tenantId: t, conversationId: next, now: now() })
      expect(await bells(next)).toBe(0)
      expect((await db.conversation.findUniqueOrThrow({ where: { id: next } })).status).toBe("PENDING_INTERNAL")
    })

    it("60 hand-offs rung at the same moment ring exactly 30 conversations: the count and the bells are taken under one lock", async () => {
      const { t } = await tenant()
      const ids = await many(t, 60, new Date())
      const results = await Promise.allSettled(ids.map((id) => notifyStaffOfHandoff({ tenantId: t, conversationId: id, now: now() })))
      expect(results.filter((r) => r.status === "rejected")).toEqual([])
      const rung = await db.notification.findMany({ where: { tenantId: t, type: "CHAT_HANDOFF" }, distinct: ["entityId"], select: { entityId: true } })
      expect(rung).toHaveLength(30)
    }, 120_000)

    it("a chat handed off again in the hour rings again: it is not a new conversation", async () => {
      const { t, admin } = await tenant()
      await rang(t, [admin], 29, MIN)
      const id = await handedOff(t, now())
      await notifyStaffOfHandoff({ tenantId: t, conversationId: id, now: now() })
      await notifyStaffOfHandoff({ tenantId: t, conversationId: id, now: now() })
      expect(await bells(id)).toBe(2)
    })

    it("chats staff joined still count, and another tenant's busy hour does not silence this one", async () => {
      const { t, admin } = await tenant()
      const other = await tenant()
      await rang(other.t, [other.admin], 40, MIN)
      const joined: string[] = []
      for (let i = 0; i < 30; i++) {
        const id = await handedOff(t, now())
        await notifyStaffOfHandoff({ tenantId: t, conversationId: id, now: now() })
        expect(await joinChat({ tenantId: t, conversationId: id, staffUserId: admin, now: now() })).toEqual({ ok: true })
        joined.push(id)
      }
      expect(await db.websiteChatHandoff.count({ where: { tenantId: t } })).toBe(0)
      const next = await handedOff(t, now())
      await notifyStaffOfHandoff({ tenantId: t, conversationId: next, now: now() })
      expect(await bells(next)).toBe(0)

      const quiet = await tenant()
      const theirs = await handedOff(quiet.t, now())
      await notifyStaffOfHandoff({ tenantId: quiet.t, conversationId: theirs, now: now() })
      expect(await bells(theirs)).toBe(1)
    }, 60_000)
  })
})
