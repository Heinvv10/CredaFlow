/**
 * Real-Postgres proof of the live-takeover side of the chat store: the chat ref,
 * the transcript the visitor polls, and visitor messages sent while staff hold
 * the chat (row lock, own cap, no daily lock).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/store-staff.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { DAILY_BOT_REPLY_CAP, MAX_VISITOR_MESSAGES_WITH_STAFF } from "./constants"
import { countTodaysVisitorMessages } from "./limits"
import { loadChat, recordAssistantReply, recordVisitorMessage, recordVisitorMessageToStaff, startChat, visitorLead } from "./store"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("website chat with staff", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_web_staff_${token}`
  const named = `user_named_${token}`
  const nameless = `user_nameless_${token}`
  const t0 = new Date("2026-09-29T10:00:00Z")
  /** What the store writes for the in-hours hand-off below: the model's text, then the line. */
  const HANDED = "I'll ask a consultant.\n\nI can't help with that here, so I'll connect you to a consultant."
  const at = (min: number) => new Date(t0.getTime() + min * 60_000)
  const fields = (key: string) => ({ firstName: "Sipho", lastName: "Dlamini", phone: "27825550001", email: `${key}-${token}@test.invalid` })
  const inbound = (conversationId: string, n: number) => db.message.createMany({ data: Array.from({ length: n }, (_, i) => ({
    tenantId, conversationId, channel: "CHATBOT" as const, provider: "CHATBOT" as const, direction: "INBOUND" as const, status: "DELIVERED" as const, bodyText: `f${i}`,
  })) })

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `web-staff-${token}`, name: "Website chat staff IT", domain: null } })
    await db.user.create({ data: { id: named, tenantId, email: `named-${token}@test.invalid`, password: "x", name: "Thandi Mokoena" } })
    await db.user.create({ data: { id: nameless, tenantId, email: `nameless-${token}@test.invalid`, password: "x", name: null } })
  })

  afterAll(async () => {
    await db.message.deleteMany({ where: { tenantId } })
    await db.conversation.deleteMany({ where: { tenantId } }) // cascades WebsiteChatHandoff
    await db.contactConsent.deleteMany({ where: { tenantId } })
    await db.contact.deleteMany({ where: { tenantId } })
    await db.crmActivity.deleteMany({ where: { tenantId } })
    await db.lead.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("stores the chat ref on the thread and in the first note, and reads the visitor's lead through it", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: fields("ref"), now: t0 })
    expect(r.ref).toMatch(/^WC-[A-HJ-NP-Z2-9]{6}$/)
    const conv = await db.conversation.findUniqueOrThrow({ where: { id: r.conversationId }, include: { messages: { where: { direction: "INTERNAL_NOTE" } } } })
    expect(conv.subject).toBe(`Website chat ${r.ref}`)
    expect(conv.messages[0].bodyText?.split("\n").slice(1, 3)).toEqual([`Chat ref: ${r.ref}`, `CRM lead: /crm/leads/${r.leadId}`])
    expect((await loadChat(tenantId, r.conversationId))?.ref).toBe(r.ref)
    expect(await prisma.$transaction((tx) => visitorLead(tx, tenantId, r.conversationId))).toEqual({ firstName: "Sipho", lastName: "Dlamini", phone: "27825550001" })

    // A chat opened before refs existed has none.
    await db.conversation.update({ where: { id: r.conversationId }, data: { subject: "Website chat" } })
    expect((await loadChat(tenantId, r.conversationId))?.ref).toBeNull()
  })

  it("returns the transcript in createdAt, id order with who said each line, and follows chatMode", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: fields("lines"), now: t0 })
    const id = r.conversationId
    await recordVisitorMessage({ tenantId, conversationId: id, text: "Can I speak to someone?", now: at(1) })
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "bot", staffFirstName: null, handedOff: false, closed: false })

    await recordAssistantReply({ tenantId, conversationId: id, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: at(2) })
    // The hand-off opened its own wait; once that times out, or for a chat staff set pending by hand (no row), it is the fallback.
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "waiting", staffFirstName: null, handedOff: true })
    await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { timedOutAt: at(4) } })
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "fallback", staffFirstName: null })
    await db.websiteChatHandoff.delete({ where: { conversationId: id } })
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "fallback", staffFirstName: null, handedOff: true })

    // Two rows in the same instant, inserted against id order: id breaks the tie.
    const same = new Date(Date.now() + 60_000)
    const row = { tenantId, conversationId: id, channel: "CHATBOT" as const, provider: "CHATBOT" as const, status: "DELIVERED" as const, createdAt: same }
    await db.message.create({ data: { ...row, id: `zz_${token}`, direction: "INBOUND", bodyText: "Thanks" } })
    await db.message.create({ data: { ...row, id: `aa_${token}`, direction: "OUTBOUND", createdById: named, bodyText: "Hi, Thandi here." } })
    await db.conversation.update({ where: { id }, data: { assigneeId: named, status: "OPEN" } })

    const chat = await loadChat(tenantId, id)
    expect(chat).toMatchObject({ mode: "staff", staffFirstName: "Thandi" })
    expect(chat?.lines.map((l) => [l.from, l.text])).toEqual([
      ["assistant", r.greeting], ["visitor", "Can I speak to someone?"], ["assistant", HANDED],
      ["staff", "Hi, Thandi here."], ["visitor", "Thanks"],
    ])
    expect(chat?.lines.slice(3).map((l) => l.id)).toEqual([`aa_${token}`, `zz_${token}`])
    // Only a staff line carries a name: its author's first name.
    expect(chat?.lines.map((l) => l.name)).toEqual([undefined, undefined, undefined, "Thandi", undefined])
    expect(chat?.lines.every((l) => l.id.length > 0)).toBe(true)
    // Internal notes never reach the visitor; the model gets the assistant's own conversation, no staff line.
    expect(chat?.lines.some((l) => l.text.includes("NOT verified") || l.text.startsWith("Needs human"))).toBe(false)
    expect(chat?.turns).toEqual([
      { role: "assistant", text: r.greeting }, { role: "visitor", text: "Can I speak to someone?" },
      { role: "assistant", text: HANDED }, { role: "visitor", text: "Thanks" },
    ])

    await db.conversation.update({ where: { id }, data: { assigneeId: nameless } })
    await db.message.update({ where: { id: `aa_${token}` }, data: { createdById: nameless } })
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "staff", staffFirstName: "A consultant" })
    expect((await loadChat(tenantId, id))?.lines[3].name).toBe("Consultant")
    await db.user.update({ where: { id: nameless }, data: { name: "   " } })
    expect((await loadChat(tenantId, id))?.staffFirstName).toBe("A consultant")
    await db.conversation.update({ where: { id }, data: { status: "CLOSED", closedAt: at(9) } })
    expect(await loadChat(tenantId, id)).toMatchObject({ mode: "ended", staffFirstName: null, closed: true })
  })

  it("stores a visitor message for staff under the row lock, past the daily cap and without the daily lock", async () => {
    const now = new Date()
    const filler = await startChat({ brand: "Acme Lending", tenantId, fields: fields("filler"), now })
    await inbound(filler.conversationId, DAILY_BOT_REPLY_CAP)
    await db.conversation.update({ where: { id: filler.conversationId }, data: { lastInboundAt: now, lastActivityAt: now } })
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: fields("staff"), now })
    const id = r.conversationId
    await db.conversation.update({ where: { id }, data: { assigneeId: named } })
    await inbound(id, MAX_VISITOR_MESSAGES_WITH_STAFF - 1)
    const msg = { tenantId, conversationId: id, now }

    // Another chat of this tenant holds the daily lock for the whole call: it must not wait for it.
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId} || ':webchat-day'))`
      expect(await recordVisitorMessageToStaff({ ...msg, text: "Are you there?" })).toEqual({ accepted: true })
    }, { timeout: 10_000 })
    const stored = await db.message.findFirstOrThrow({ where: { conversationId: id, bodyText: "Are you there?" } })
    // MANUAL, not CHATBOT: no model call was made for it, so it is not counted against the daily model cap.
    expect(stored).toMatchObject({ tenantId, channel: "CHATBOT", provider: "MANUAL", direction: "INBOUND", status: "DELIVERED", createdById: null })
    expect(await db.conversation.findUniqueOrThrow({ where: { id }, select: { lastInboundAt: true, lastActivityAt: true } })).toEqual({ lastInboundAt: now, lastActivityAt: now })

    // At the staff-mode cap: refused, nothing written, nothing stamped.
    const later = new Date(now.getTime() + 60_000)
    expect(await recordVisitorMessageToStaff({ ...msg, now: later, text: "over" })).toEqual({ accepted: false, reason: "staff_cap" })
    expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBe(MAX_VISITOR_MESSAGES_WITH_STAFF)
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toEqual(now)
  }, 60_000)

  it("a message racing the one that fills the staff-mode cap waits for the row lock and is refused", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: fields("race"), now: t0 })
    const id = r.conversationId
    await db.conversation.update({ where: { id }, data: { assigneeId: named } })
    await inbound(id, MAX_VISITOR_MESSAGES_WITH_STAFF - 1)
    let racer: ReturnType<typeof recordVisitorMessageToStaff> | undefined
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${id} FOR UPDATE`
      await tx.message.create({ data: { tenantId, conversationId: id, channel: "CHATBOT", direction: "INBOUND", provider: "CHATBOT", status: "DELIVERED", bodyText: "last" } })
      racer = recordVisitorMessageToStaff({ tenantId, conversationId: id, text: "racer", now: t0 })
      await new Promise((done) => setTimeout(done, 300))
    }, { timeout: 10_000 })
    expect(await racer).toEqual({ accepted: false, reason: "staff_cap" })
    expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBe(MAX_VISITOR_MESSAGES_WITH_STAFF)
  })

  it("a message meant for staff on a chat staff have handed back writes nothing and says so, so the caller can ask the assistant", async () => {
    const id = (await startChat({ brand: "Acme Lending", tenantId, fields: fields("handed-back"), now: t0 })).conversationId
    expect(await recordVisitorMessageToStaff({ tenantId, conversationId: id, text: "still there?", now: at(1) })).toEqual({ accepted: false, reason: "not_staff" })
    expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBe(0)
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toBeNull()
  })

  describe("the mode is decided again under the row lock", () => {
    const outbound = (id: string) => db.message.count({ where: { conversationId: id, direction: "OUTBOUND" } })
    const inboundTexts = async (id: string) => (await db.message.findMany({ where: { conversationId: id, direction: "INBOUND" }, orderBy: { createdAt: "asc" } })).map((m) => m.bodyText)
    async function chat(key: string) {
      return (await startChat({ brand: "Acme Lending", tenantId, fields: fields(key), now: t0 })).conversationId
    }
    // A day nothing has been stored on yet: the daily-cap test above filled today for this tenant.
    const day = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)

    it("recordVisitorMessage keeps the message for staff once a hand-off is open or staff hold the chat, not once it timed out", async () => {
      const id = await chat("relock")
      const send = (text: string) => recordVisitorMessage({ tenantId, conversationId: id, text, now: day })
      expect(await send("to the bot")).toEqual({ accepted: true })

      await recordAssistantReply({ tenantId, conversationId: id, reply: "I'll ask.", needsHuman: true, reason: "out_of_scope", now: at(2) })
      expect(await send("while waiting")).toEqual({ accepted: false, reason: "to_staff", stored: true })

      await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { timedOutAt: at(4) } })
      expect(await send("after the time-out")).toEqual({ accepted: true })

      await db.conversation.update({ where: { id }, data: { assigneeId: named } })
      expect(await send("with staff")).toEqual({ accepted: false, reason: "to_staff", stored: true })
      expect(await inboundTexts(id)).toEqual(["to the bot", "while waiting", "after the time-out", "with staff"])
      expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toEqual(day)
    })

    it("recordVisitorMessage with staff uses the staff-mode cap and ignores the bot's caps", async () => {
      const id = await chat("relock-cap")
      await db.conversation.update({ where: { id }, data: { assigneeId: named } })
      // Past the bot's per-chat cap, one short of the staff-mode cap.
      await inbound(id, MAX_VISITOR_MESSAGES_WITH_STAFF - 1)
      const msg = { tenantId, conversationId: id, now: at(1) }
      expect(await recordVisitorMessage({ ...msg, text: "last" })).toEqual({ accepted: false, reason: "to_staff", stored: true })
      expect(await recordVisitorMessage({ ...msg, text: "over" })).toEqual({ accepted: false, reason: "to_staff", stored: false })
      expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBe(MAX_VISITOR_MESSAGES_WITH_STAFF)
    })

    it("recordAssistantReply writes nothing into a chat staff hold, hand-off included", async () => {
      const id = await chat("suppress")
      expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "Hello.", needsHuman: false, reason: null, now: at(1) })).toEqual({ handedOffNow: false, suppressed: false, reply: "Hello." })
      await db.conversation.update({ where: { id }, data: { assigneeId: named } })
      const before = await db.conversation.findUniqueOrThrow({ where: { id } })

      expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "bot text", needsHuman: true, reason: "complaint", now: at(5) })).toEqual({ handedOffNow: false, suppressed: true })
      expect(await outbound(id)).toBe(2) // greeting + "Hello."
      expect(await db.message.count({ where: { conversationId: id, bodyText: { startsWith: "Needs human" } } })).toBe(0)
      expect(await db.conversation.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: before.status, priority: before.priority, lastOutboundAt: at(1) })
    })

    it("recordAssistantReply waits for a join that has not committed yet, then writes nothing", async () => {
      const id = await chat("suppress-lock")
      let reply: Promise<{ suppressed: boolean }> | undefined
      try {
        await db.$transaction(async (tx) => {
          await tx.conversation.update({ where: { id }, data: { assigneeId: named } })
          reply = recordAssistantReply({ tenantId, conversationId: id, reply: "bot text", needsHuman: false, reason: null, now: at(1) })
          await new Promise((done) => setTimeout(done, 300))
        }, { timeout: 10_000 })
      } finally {
        // Settled here so it cannot run into the next test; asserted after, so it cannot replace a failure above.
        await Promise.allSettled([reply])
      }
      expect((await reply)?.suppressed).toBe(true)
      expect(await outbound(id)).toBe(1)
    })
  })

  it("50 messages kept for staff leave the tenant's count for the daily model cap unchanged, and all show in the transcript", async () => {
    const now = new Date()
    const today = () => prisma.$transaction((tx) => countTodaysVisitorMessages(tx, tenantId, now))
    const id = (await startChat({ brand: "Acme Lending", tenantId, fields: fields("no-count"), now })).conversationId
    await db.conversation.update({ where: { id }, data: { assigneeId: named } })
    const before = await today()
    for (let i = 0; i < 25; i++) {
      // Both doors into staff mode: the route's own, and the re-check under the row lock.
      expect(await recordVisitorMessageToStaff({ tenantId, conversationId: id, text: `a${i}`, now })).toEqual({ accepted: true })
      expect(await recordVisitorMessage({ tenantId, conversationId: id, text: `b${i}`, now })).toEqual({ accepted: false, reason: "to_staff", stored: true })
    }
    expect(await today()).toBe(before)
    // The visitor still sees every one; the model is sent none of them.
    const chat = await loadChat(tenantId, id)
    expect(chat?.lines.filter((l) => l.from === "visitor")).toHaveLength(50)
    expect(chat?.turns.filter((t) => t.role === "visitor")).toHaveLength(0)
    expect(await db.message.count({ where: { conversationId: id, channel: "CHATBOT", direction: "INBOUND" } })).toBe(50)

    // A message the bot is asked about does count.
    await db.conversation.update({ where: { id }, data: { assigneeId: null } })
    await db.message.create({ data: { tenantId, conversationId: id, channel: "CHATBOT", provider: "CHATBOT", direction: "INBOUND", status: "DELIVERED", bodyText: "to the bot" } })
    expect(await today()).toBe(before + 1)
  }, 60_000)

  it("recordVisitorMessage waits for a close that has not committed yet, then refuses and writes nothing", async () => {
    const id = (await startChat({ brand: "Acme Lending", tenantId, fields: fields("close-race"), now: t0 })).conversationId
    let racer: Promise<unknown> = Promise.resolve()
    await db.$transaction(async (tx) => {
      await tx.conversation.update({ where: { id }, data: { status: "CLOSED", closedAt: at(1) } })
      racer = recordVisitorMessage({ tenantId, conversationId: id, text: "still there?", now: at(1) })
      await new Promise((done) => setTimeout(done, 300))
    }, { timeout: 10_000 })
    expect(await racer).toEqual({ accepted: false, reason: "closed" })
    expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBe(0)
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toBeNull()
  })

  it("refuses a visitor message on a closed chat and writes nothing", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: fields("closed"), now: t0 })
    await db.conversation.update({ where: { id: r.conversationId }, data: { status: "CLOSED", closedAt: at(1) } })
    expect(await recordVisitorMessageToStaff({ tenantId, conversationId: r.conversationId, text: "hello?", now: at(2) })).toEqual({ accepted: false, reason: "closed" })
    expect(await recordVisitorMessage({ tenantId, conversationId: r.conversationId, text: "hello?", now: at(2) })).toEqual({ accepted: false, reason: "closed" })
    expect(await db.message.count({ where: { conversationId: r.conversationId, direction: "INBOUND" } })).toBe(0)
    expect((await db.conversation.findUniqueOrThrow({ where: { id: r.conversationId } })).lastInboundAt).toBeNull()
  })
})
