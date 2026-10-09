/**
 * Real-Postgres proof of the hand-off lifecycle: the handoff row written with the
 * status flip, who gets the bell item, the bot's silence while the visitor waits,
 * and the conditional time-out that only one caller can win.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/handoff.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { expireHandoffIfDue, notifyStaffOfHandoff } from "./handoff"
import { loadChat, recordAssistantReply, startChat } from "./store"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("website chat hand-off", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_web_handoff_${token}`
  const other = `tenant_web_handoff2_${token}`
  const closedAllWeek = `tenant_web_handoff3_${token}`
  const tenants = [tenantId, other, closedAllWeek]
  const admin = `user_admin_${token}`
  const flagged = `user_flagged_${token}`
  // Tuesday 12:00 SAST: inside the default hours. 22:00 SAST: outside them.
  const open = new Date("2026-09-29T10:00:00Z")
  const afterHours = new Date("2026-09-29T20:00:00Z")
  const plus = (d: Date, ms: number) => new Date(d.getTime() + ms)

  async function chat(key: string, tenant = tenantId) {
    return (await startChat({ brand: "Acme Lending", tenantId: tenant, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550002", email: `${key}-${token}@test.invalid` }, now: open })).conversationId
  }
  /** The hand-off lines for this suite's default business hours. */
  const IN_HOURS_LINE = "I can't help with that here, so I'll connect you to a consultant."
  const AWAY_LINE = "Our consultants aren't available right now. They're available Monday to Friday, 08:00 to 17:00."
  /** The bot's hand-off: the reply that flips the chat to PENDING_INTERNAL. */
  const handOff = (conversationId: string, now = open, tenant = tenantId) =>
    recordAssistantReply({ tenantId: tenant, conversationId, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now })
  const row = (conversationId: string) => db.websiteChatHandoff.findUniqueOrThrow({ where: { conversationId } })
  const bell = (conversationId: string) => db.notification.findMany({ where: { entityId: conversationId }, orderBy: { userId: "asc" } })
  const outbound = async (conversationId: string) => (await db.message.findMany({ where: { conversationId, direction: "OUTBOUND" }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((m) => m.bodyText)

  beforeAll(async () => {
    for (const id of tenants) await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat hand-off IT", domain: null } })
    const user = (id: string, data: { tenantId?: string; role?: "ADMIN" | "SUPER_ADMIN" | "CREDIT_OFFICER"; isCommsAgent?: boolean; active?: boolean }) =>
      db.user.create({ data: { tenantId, ...data, id, email: `${id}@test.invalid`, password: "x" } })
    await user(admin, { role: "ADMIN" })
    await user(flagged, { role: "CREDIT_OFFICER", isCommsAgent: true })
    await user(`user_plain_${token}`, { role: "CREDIT_OFFICER" })
    await user(`user_inactive_${token}`, { role: "ADMIN", active: false })
    await user(`user_inactive_flag_${token}`, { role: "CREDIT_OFFICER", isCommsAgent: true, active: false })
    await user(`user_elsewhere_${token}`, { tenantId: other, role: "SUPER_ADMIN", isCommsAgent: true })
    await db.commsSettings.create({ data: { tenantId: closedAllWeek, businessHours: { tz: "Africa/Johannesburg", days: { mon: null } } } })
  })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await db.notification.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where }) // cascades WebsiteChatHandoff
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.commsSettings.deleteMany({ where })
    await db.tenant.deleteMany({ where: { id: { in: tenants } } })
    await db.$disconnect()
  })

  it("in hours: the flip writes the row and returns waiting, with no bell call needed for the visitor to be waiting", async () => {
    const id = await chat("open")
    expect(await handOff(id)).toEqual({ handedOffNow: true, suppressed: false, mode: "waiting", reply: `I'll ask a consultant.\n\n${IN_HOURS_LINE}` })
    expect(await row(id)).toMatchObject({ tenantId, handedOffAt: open, timedOutAt: null, alertEmailSentAt: null, alertAttempts: 0 })
    // Nothing has rung staff yet: a poll or a second message here must already see the wait.
    expect(await bell(id)).toEqual([])
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "waiting", handedOff: true })
  })

  it("after hours: the row is born timed out and the flip returns fallback", async () => {
    const id = await chat("closed")
    expect(await handOff(id, afterHours)).toEqual({ handedOffNow: true, suppressed: false, mode: "fallback", reply: `I'll ask a consultant.\n\n${AWAY_LINE}` })
    expect(await row(id)).toMatchObject({ handedOffAt: afterHours, timedOutAt: afterHours, alertEmailSentAt: null, alertAttempts: 0 })
    expect((await loadChat(tenantId, id))?.mode).toBe("fallback")
  })

  it("uses the tenant's own business hours", async () => {
    const id = await chat("hours", closedAllWeek)
    expect(await handOff(id, open, closedAllWeek)).toMatchObject({ handedOffNow: true, mode: "fallback" })
    expect((await row(id)).timedOutAt).toEqual(open)
  })

  it("a reply that does not flip the status writes no row and reports no mode", async () => {
    const id = await chat("no-flip")
    expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "Hello.", needsHuman: false, reason: null, now: open })).toEqual({ handedOffNow: false, suppressed: false, reply: "Hello." })
    expect(await db.websiteChatHandoff.count({ where: { conversationId: id } })).toBe(0)
  })

  it("a second hand-off on the same chat resets the row instead of adding one", async () => {
    const id = await chat("again")
    await handOff(id, afterHours)
    await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { alertEmailSentAt: afterHours, alertAttempts: 3 } })
    const first = await row(id)

    // Staff reopened the chat; the next morning the bot hands it off again.
    await db.conversation.update({ where: { id }, data: { status: "OPEN" } })
    const next = plus(open, 24 * 60 * 60 * 1000)
    expect(await handOff(id, next)).toMatchObject({ handedOffNow: true, mode: "waiting" })
    expect(await db.websiteChatHandoff.count({ where: { conversationId: id } })).toBe(1)
    expect(await row(id)).toMatchObject({ id: first.id, handedOffAt: next, timedOutAt: null, alertEmailSentAt: null, alertAttempts: 0 })
  })

  it("writes nothing for a chat of another tenant: no reply, no flip, no row", async () => {
    const id = await chat("foreign", other)
    expect(await handOff(id)).toEqual({ handedOffNow: false, suppressed: true })
    expect(await db.websiteChatHandoff.count({ where: { conversationId: id } })).toBe(0)
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).status).toBe("OPEN")
    expect(await db.message.count({ where: { conversationId: id, tenantId } })).toBe(0)
  })

  describe("while the visitor waits the bot writes nothing", () => {
    it("an answer still in flight when the hand-off opened is suppressed, hand-off or not", async () => {
      const id = await chat("in-flight")
      await handOff(id)
      const before = await outbound(id)
      for (const needsHuman of [false, true]) {
        expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "SLOW BOT ANSWER", needsHuman, reason: needsHuman ? "complaint" : null, now: plus(open, 5000) }))
          .toEqual({ handedOffNow: false, suppressed: true })
      }
      expect(await outbound(id)).toEqual(before)
      expect(await db.message.count({ where: { conversationId: id, bodyText: { startsWith: "Needs human" } } })).toBe(1)
      expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastOutboundAt).toEqual(open)
    })

    it("once the wait timed out the bot answers again, and a further hand-off reply opens no second wait", async () => {
      const id = await chat("timed-out")
      await handOff(id)
      expect(await expireHandoffIfDue({ tenantId, conversationId: id, now: plus(open, 120_000) })).toBe(true)
      const later = plus(open, 180_000)
      expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "We open at 08:00.", needsHuman: false, reason: null, now: later })).toEqual({ handedOffNow: false, suppressed: false, reply: "We open at 08:00." })
      // Still the fallback (no new wait), within business hours: nobody can join, and no hours are named.
      const again = "I'll ask again.\n\nOur consultants can't join the chat right now."
      expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "I'll ask again.", needsHuman: true, reason: "complaint", now: later })).toEqual({ handedOffNow: false, suppressed: false, reply: again })
      expect((await outbound(id)).slice(-2)).toEqual(["We open at 08:00.", again])
      expect((await row(id)).timedOutAt).toEqual(plus(open, 120_000))
    })
  })

  describe("notifyStaffOfHandoff", () => {
    it("rings only this tenant's active inbox staff, naming the visitor", async () => {
      const id = await chat("bell")
      await handOff(id)
      await notifyStaffOfHandoff({ tenantId, conversationId: id, now: open })
      const items = await bell(id)
      expect(items.map((n) => n.userId)).toEqual([admin, flagged])
      for (const n of items) {
        expect(n).toMatchObject({
          tenantId, type: "CHAT_HANDOFF", title: "Website chat needs a person", body: "Sipho is waiting on the website chat.",
          entityType: "Conversation", entityId: id, readAt: null,
        })
      }
      // It writes bell items only: the row is the flip's.
      expect(await row(id)).toMatchObject({ handedOffAt: open, timedOutAt: null })
    })

    it("a tenant with no inbox staff gets no bell item", async () => {
      const id = await chat("no-staff", closedAllWeek)
      await handOff(id, open, closedAllWeek)
      await notifyStaffOfHandoff({ tenantId: closedAllWeek, conversationId: id, now: open })
      expect(await bell(id)).toEqual([])
    })

    it("a chat with no readable lead still rings, without a name", async () => {
      const id = await chat("nolead")
      await handOff(id)
      await db.message.deleteMany({ where: { conversationId: id, direction: "INTERNAL_NOTE" } })
      await notifyStaffOfHandoff({ tenantId, conversationId: id, now: open })
      expect((await bell(id)).map((n) => n.body)).toEqual(Array(2).fill("A visitor is waiting on the website chat."))
    })
  })

  describe("expireHandoffIfDue", () => {
    async function waiting(key: string) {
      const id = await chat(key)
      await handOff(id)
      return id
    }
    const due = plus(open, 120_000)

    it("is false at 119s, true at 120s and sets timedOutAt, then false again", async () => {
      const id = await waiting("due")
      expect(await expireHandoffIfDue({ tenantId, conversationId: id, now: plus(open, 119_000) })).toBe(false)
      expect((await row(id)).timedOutAt).toBeNull()
      expect(await expireHandoffIfDue({ tenantId, conversationId: id, now: due })).toBe(true)
      expect((await row(id)).timedOutAt).toEqual(due)
      expect(await expireHandoffIfDue({ tenantId, conversationId: id, now: plus(due, 60_000) })).toBe(false)
      expect((await row(id)).timedOutAt).toEqual(due)
    })

    it.each([
      ["has an assignee", { assigneeId: admin }],
      ["is closed", { closedAt: due }],
      ["is no longer pending", { status: "OPEN" as const }],
    ])("is false when the conversation %s", async (name, data) => {
      const id = await waiting(`skip-${name.replaceAll(" ", "-")}`)
      await db.conversation.update({ where: { id }, data })
      expect(await expireHandoffIfDue({ tenantId, conversationId: id, now: due })).toBe(false)
      expect((await row(id)).timedOutAt).toBeNull()
    })

    it("is false for another tenant's id", async () => {
      const id = await waiting("tenant")
      expect(await expireHandoffIfDue({ tenantId: other, conversationId: id, now: due })).toBe(false)
      expect((await row(id)).timedOutAt).toBeNull()
    })

    it("waits for a staff join that has not committed yet, then leaves the chat to staff", async () => {
      const id = await waiting("join")
      let expiry: Promise<boolean> | undefined
      // A join holds the thread row with assigneeId uncommitted. Without the row lock the
      // expiry would read the committed row (no assignee) and time the chat out.
      let midway: Date | null | undefined
      try {
        await db.$transaction(async (tx) => {
          await tx.conversation.update({ where: { id }, data: { assigneeId: admin } })
          expiry = expireHandoffIfDue({ tenantId, conversationId: id, now: due })
          await new Promise((done) => setTimeout(done, 300))
          midway = (await row(id)).timedOutAt
        }, { timeout: 10_000 })
      } finally {
        // Always settled, so a failure above cannot leave the expiry running into the next test.
        // Asserted after the block: an assertion thrown from here would replace that failure.
        await Promise.allSettled([expiry])
      }
      expect(await expiry).toBe(false)
      expect(midway).toBeNull()
      expect((await row(id)).timedOutAt).toBeNull()
    })

    it("20 parallel calls: exactly one wins", async () => {
      const id = await waiting("race")
      const won = await Promise.all(Array.from({ length: 20 }, () => expireHandoffIfDue({ tenantId, conversationId: id, now: due })))
      expect(won.filter(Boolean)).toHaveLength(1)
    })
  })
})
