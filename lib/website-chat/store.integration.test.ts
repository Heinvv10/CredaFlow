/**
 * Real-Postgres proof of the chat record rules that mocks cannot see: the
 * one-open-thread index, the note trigger and CHECK constraints, the row lock
 * behind the message cap, the conditional hand-off, and the inbox badge query.
 *
 * Run only against a fully migrated throwaway database:
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/store.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

// Only the daily-cap burst suite drives the route; these mocks leave the store untouched.
const rt = vi.hoisted(() => ({ tenantId: "", ask: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => ({ id: rt.tenantId }) }))
vi.mock("@/lib/audit", () => ({ logAudit: async () => undefined }))
// The anonymous message route must never load NextAuth: importing it here fails this file.
vi.mock("@/lib/auth", () => { throw new Error("the website chat message route reached @/lib/auth") })
vi.mock("@/lib/public-loan-products-server", () => ({ getLivePublicProductsServer: async () => [], getLivePricingServer: async () => ({}) }))
vi.mock("@/lib/website-chat/model", async (orig) => ({ ...(await orig<object>()), askAssistant: rt.ask }))

import { PrismaClient } from "@prisma/client"
import type { NextRequest } from "next/server"
import { POST as postMessage } from "@/app/api/website/chat/message/route"
import { countUnansweredConversations } from "@/lib/inbox/unanswered"
import { DAILY_BOT_REPLY_CAP, MAX_VISITOR_MESSAGES } from "./constants"
import { loadChat, recordAssistantReply, recordVisitorMessage, startChat } from "./store"
import { issueChatToken } from "./token"

const RUN = process.env.RUN_DB_IT === "1"
/** The hand-off line for a tenant with no open day (the daily-cap suite's settings). */
const CLOSED_LINE = "Our consultants aren't available right now."
const suite = RUN ? describe : describe.skip

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_web_chat_${token}`
const PHONE = "27821234567"
const FIELDS = { firstName: "Thandi", lastName: "Mokoena", phone: PHONE, email: `chat-${token}@test.invalid` }

suite("website chat records", () => {
  // Same DATABASE_URL as the global client that store.ts and countUnansweredConversations use.
  const db = new PrismaClient()
  const oldContactId = `contact_old_${token}`
  const t0 = new Date("2026-09-29T10:00:00Z")

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `web-chat-${token}`, name: "Website Chat IT", domain: null } })
    await db.contact.create({
      data: { id: oldContactId, tenantId, status: "LEAD", firstSeenChannel: "SMS", firstName: "Old", lastName: "Contact" },
    })
    await db.contactIdentity.create({
      data: { tenantId, contactId: oldContactId, channel: "SMS", value: PHONE, source: "IMPORT" },
    })
  })

  afterAll(async () => {
    const convs = { conversation: { tenantId } }
    await db.message.deleteMany({ where: convs })
    await db.conversation.deleteMany({ where: { tenantId } })
    await db.contactConsent.deleteMany({ where: { tenantId } })
    await db.contactIdentity.deleteMany({ where: { tenantId } })
    await db.contact.deleteMany({ where: { tenantId } })
    await db.crmActivity.deleteMany({ where: { tenantId } })
    await db.lead.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("commits a chat unlinked from its lead, flags a match without linking, and hands off once", async () => {
    const before = await db.contactIdentity.findMany({ where: { contactId: oldContactId } })
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: FIELDS, now: t0 })

    expect(await db.contactIdentity.count({ where: { contactId: r.contactId } })).toBe(0)
    const contact = await db.contact.findUniqueOrThrow({ where: { id: r.contactId } })
    expect(contact.leadId).toBeNull()
    expect(contact.primaryPhone).toBeNull()
    expect(contact.primaryEmail).toBeNull()
    expect(contact.clientId).toBeNull()
    expect(await db.contactConsent.count({ where: { contactId: r.contactId, purpose: "CHATBOT_TRANSCRIPT_RETAIN" } })).toBe(1)

    const conv = await db.conversation.findUniqueOrThrow({ where: { id: r.conversationId }, include: { messages: true } })
    expect(conv.channel).toBe("CHATBOT")
    expect(conv.closedAt).toBeNull()
    const notes = conv.messages.filter((m) => m.direction === "INTERNAL_NOTE")
    expect(notes).toHaveLength(1)
    expect(notes[0].bodyText).toContain(`CRM lead: /crm/leads/${r.leadId}`)
    expect(conv.messages.filter((m) => m.direction === "OUTBOUND")).toHaveLength(1)
    const activity = await db.crmActivity.findFirstOrThrow({ where: { tenantId, leadId: r.leadId } })
    expect(activity.notes).toContain(`Inbox thread: /inbox?conversationId=${r.conversationId}`)

    expect(r.matchedContactIds).toContain(oldContactId)
    expect(await db.contactIdentity.findMany({ where: { contactId: oldContactId } })).toEqual(before)

    const at = (min: number) => new Date(t0.getTime() + min * 60_000)
    expect(await recordVisitorMessage({ tenantId, conversationId: r.conversationId, text: "What are your hours?", now: at(1) })).toEqual({ accepted: true })
    await recordAssistantReply({ tenantId, conversationId: r.conversationId, reply: "08:00 to 17:00.", needsHuman: false, reason: null, now: at(2) })
    // The bot answered, so the badge owes nothing yet.
    expect(await countUnansweredConversations(tenantId)).toBe(0)

    await recordVisitorMessage({ tenantId, conversationId: r.conversationId, text: "Do I owe you money?", now: at(3) })
    const first = await recordAssistantReply({ tenantId, conversationId: r.conversationId, reply: "Someone will call you.", needsHuman: true, reason: "account_question", now: at(4) })
    const second = await recordAssistantReply({ tenantId, conversationId: r.conversationId, reply: "Someone will call you.", needsHuman: true, reason: "complaint", now: at(5) })
    // In hours the first hand-off opened the wait for staff; a second reply landing in it is not written.
    expect(first).toEqual({ handedOffNow: true, suppressed: false, mode: "waiting", reply: "Someone will call you.\n\nI can't help with that here, so I'll connect you to a consultant." })
    expect(second).toEqual({ handedOffNow: false, suppressed: true })
    expect(await countUnansweredConversations(tenantId)).toBe(1)

    const after = await db.conversation.findUniqueOrThrow({ where: { id: r.conversationId }, include: { messages: { where: { direction: "INTERNAL_NOTE" }, orderBy: { createdAt: "asc" } } } })
    expect(after.status).toBe("PENDING_INTERNAL")
    expect(after.priority).toBe("HIGH")
    expect(after.lastOutboundAt).toEqual(at(4))
    expect(after.messages.map((m) => m.bodyText).filter((b) => b?.startsWith("Needs human"))).toEqual([
      "Needs human: a question about an existing account. Call the visitor on +27821234567.",
    ])

    // Traffic on another channel in the same thread never reaches the model.
    await db.message.create({ data: { tenantId, conversationId: r.conversationId, channel: "WHATSAPP", direction: "INBOUND", provider: "WA_CLOUD", status: "DELIVERED", bodyText: "whatsapp text" } })
    const loaded = await loadChat(tenantId, r.conversationId)
    expect(loaded?.turns.map((t) => t.text)).not.toContain("whatsapp text")
    expect(loaded?.turns.filter((t) => t.role === "visitor")).toHaveLength(2)
    expect(loaded?.handedOff).toBe(true)
  })

  it("a message racing the one that fills the cap waits for it, re-counts, and is refused for the assistant but kept for staff", async () => {
    const r = await startChat({ brand: "Acme Lending", tenantId, fields: { ...FIELDS, email: `cap-${token}@test.invalid` }, now: t0 })
    for (let i = 0; i < MAX_VISITOR_MESSAGES - 1; i++) {
      await recordVisitorMessage({ tenantId, conversationId: r.conversationId, text: `m${i}`, now: t0 })
    }
    // A competing writer holds the thread lock with the last allowed message uncommitted.
    // Without the lock, the racer would count 19 committed rows and insert a 21st.
    let racer: Promise<{ accepted: boolean }> | undefined
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Conversation" WHERE id = ${r.conversationId} FOR UPDATE`
      await tx.message.create({ data: { tenantId, conversationId: r.conversationId, channel: "CHATBOT", direction: "INBOUND", provider: "CHATBOT", status: "DELIVERED", bodyText: "last" } })
      racer = recordVisitorMessage({ tenantId, conversationId: r.conversationId, text: "racer", now: t0 })
      await new Promise((done) => setTimeout(done, 300))
    }, { timeout: 10_000 })
    expect(await racer).toEqual({ accepted: false, reason: "conversation_cap", stored: true })
    expect(await db.message.count({ where: { conversationId: r.conversationId, direction: "INBOUND", provider: "CHATBOT" } })).toBe(MAX_VISITOR_MESSAGES)
    expect(await db.message.findMany({ where: { conversationId: r.conversationId, bodyText: "racer" }, select: { provider: true } })).toEqual([{ provider: "MANUAL" }])
  })
})

suite("repeat visitor note", () => {
  const db = new PrismaClient()
  const mine = `tenant_web_chat_rep_${token}`
  const other = `tenant_web_chat_rep2_${token}`
  const phone = "27829990001"
  const fields = (i: number) => ({ firstName: "Rep", lastName: `V${i}`, phone, email: `rep${i}-${token}@test.invalid` })
  const firstNote = async (conversationId: string) =>
    (await db.message.findFirstOrThrow({ where: { conversationId, direction: "INTERNAL_NOTE" }, orderBy: { createdAt: "asc" } })).bodyText ?? ""

  beforeAll(async () => {
    for (const id of [mine, other]) await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website Chat repeat IT", domain: null } })
  })
  afterAll(async () => {
    for (const id of [mine, other]) await dropTenant(db, id)
    await db.$disconnect()
  })

  it("names the five newest earlier chats from the same number in this tenant, and nothing else", async () => {
    const t = (min: number) => new Date(Date.UTC(2026, 8, 29, 8, min))
    const first = await startChat({ brand: "Acme Lending", tenantId: mine, fields: fields(0), now: t(0) })
    expect(await firstNote(first.conversationId)).not.toContain("Earlier website chats")

    const earlier = [first.leadId]
    for (let i = 1; i <= 5; i++) {
      await new Promise((done) => setTimeout(done, 5)) // distinct createdAt (DB clock)
      earlier.unshift((await startChat({ brand: "Acme Lending", tenantId: mine, fields: fields(i), now: t(i) })).leadId)
    }
    // Same number and newer than all of the above, but not a website chat, or
    // another tenant's chat: never listed.
    const manual = await db.lead.create({ data: { tenantId: mine, firstName: "M", lastName: "L", phone, source: "MANUAL", tags: ["website-chat"] } })
    const untagged = await db.lead.create({ data: { tenantId: mine, firstName: "W", lastName: "F", phone, source: "WEBSITE", tags: [] } })
    const elsewhere = await startChat({ brand: "Acme Lending", tenantId: other, fields: fields(9), now: t(5) })
    const latest = await startChat({ brand: "Acme Lending", tenantId: mine, fields: fields(6), now: t(6) })
    const body = await firstNote(latest.conversationId)
    expect(body).toContain(`Earlier website chats from this number (not verified): ${earlier.slice(0, 5).map((id) => `/crm/leads/${id}`).join(", ")}.`)
    expect(body).not.toContain(first.leadId)
    expect(body).not.toContain(manual.id)
    expect(body).not.toContain(untagged.id)
    expect(body).not.toContain(elsewhere.leadId)
    // The call-back number is still read from the chat's own lead.
    const handed = await recordAssistantReply({ tenantId: mine, conversationId: latest.conversationId, reply: "x", needsHuman: true, reason: "complaint", now: t(7) })
    expect(handed.handedOffNow).toBe(true)
    expect(await db.message.count({ where: { conversationId: latest.conversationId, bodyText: { endsWith: `Call the visitor on +${phone}.` } } })).toBe(1)
    const contact = await db.contact.findUniqueOrThrow({ where: { id: latest.contactId } })
    expect(contact.leadId).toBeNull()
  }, 60_000)
})

async function dropTenant(db: PrismaClient, id: string) {
  await db.message.deleteMany({ where: { tenantId: id } })
  await db.conversation.deleteMany({ where: { tenantId: id } })
  await db.contactConsent.deleteMany({ where: { tenantId: id } })
  await db.contact.deleteMany({ where: { tenantId: id } })
  await db.crmActivity.deleteMany({ where: { tenantId: id } })
  await db.lead.deleteMany({ where: { tenantId: id } })
  await db.tenantConfig.deleteMany({ where: { tenantId: id } })
  await db.tenant.delete({ where: { id } })
}

suite("daily cap under a burst (real route + store)", () => {
  const db = new PrismaClient()
  const convs: string[] = []
  const saved = { secret: process.env.WEBSITE_CHAT_SECRET, key: process.env.ANTHROPIC_API_KEY, proxy: process.env.TRUSTED_PROXY }
  const send = (conversationId: string, now: Date) =>
    postMessage({ json: async () => ({ token: issueChatToken(conversationId, now), text: "hi" }), headers: new Headers() } as unknown as NextRequest)

  beforeAll(async () => {
    process.env.WEBSITE_CHAT_SECRET = "x".repeat(40)
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.TRUSTED_PROXY = "1"
    rt.tenantId = `tenant_web_chat_day_${token}`
    await db.tenant.create({ data: { id: rt.tenantId, slug: `web-chat-day-${token}`, name: "Website Chat daily cap IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    // Closed all week, so a hand-off is a fallback whatever the wall clock says: in hours a
    // waiting chat would keep its later messages for staff, and this suite pins the refused path.
    await db.commsSettings.create({ data: { tenantId: rt.tenantId, businessHours: { tz: "Africa/Johannesburg", days: { mon: null } } } })
    const now = new Date()
    // One filler chat already carries today's cap - 1 visitor messages; 40 fresh chats race for the last model call.
    for (let i = 0; i < 41; i++) {
      const r = await startChat({ brand: "Acme Lending", tenantId: rt.tenantId, fields: { firstName: "Rt", lastName: `N${i}`, phone: `2782${1000000 + i}`, email: `day${i}-${token}@test.invalid` }, now })
      convs.push(r.conversationId)
    }
    await db.message.createMany({ data: Array.from({ length: DAILY_BOT_REPLY_CAP - 1 }, (_, i) => ({
      tenantId: rt.tenantId, conversationId: convs[0], channel: "CHATBOT" as const, provider: "CHATBOT" as const, direction: "INBOUND" as const, status: "DELIVERED" as const, bodyText: `f${i}`,
    })) })
    // What recordVisitorMessage would have stamped for those rows.
    await db.conversation.update({ where: { id: convs[0] }, data: { lastInboundAt: now, lastActivityAt: now } })
    rt.ask.mockImplementation(async () => { await new Promise((done) => setTimeout(done, 50)); return { reply: "ok", needsHuman: false, reason: null } })
  }, 60_000)

  afterAll(async () => {
    for (const [name, value] of [["WEBSITE_CHAT_SECRET", saved.secret], ["ANTHROPIC_API_KEY", saved.key], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await db.commsSettings.deleteMany({ where: { tenantId: rt.tenantId } })
    await dropTenant(db, rt.tenantId)
    await db.$disconnect()
  })

  it("with one model call left today, 40 parallel messages on 40 chats reach the model once", async () => {
    const res = await Promise.all(convs.slice(1).map((c) => send(c, new Date())))
    expect(res.map((r) => r.status).filter((s) => s !== 200)).toEqual([])
    expect(rt.ask).toHaveBeenCalledTimes(1)
    // Every one of the 40 questions is kept for staff, but only one was answered.
    const today = await db.message.count({ where: { tenantId: rt.tenantId, direction: "INBOUND" } })
    expect(today).toBe(DAILY_BOT_REPLY_CAP - 1 + 40)
    for (const c of convs.slice(1)) {
      expect(await db.message.count({ where: { conversationId: c, direction: "INBOUND", bodyText: "hi" } })).toBe(1)
    }
    // Every refused chat was handed off once.
    expect(await db.conversation.count({ where: { tenantId: rt.tenantId, status: "PENDING_INTERNAL" } })).toBe(39)
    expect(await db.websiteChatHandoff.count({ where: { tenantId: rt.tenantId, timedOutAt: { not: null } } })).toBe(39)
    expect((await Promise.all(res.map((r) => r.json() as Promise<{ mode: string }>))).map((b) => b.mode).sort()).toEqual(["bot", ...Array(39).fill("fallback")])
  }, 60_000)

  it("a burst on one fresh chat past the cap: every message kept for staff, one hand-off, one hand-off reply", async () => {
    const fresh = await startChat({ brand: "Acme Lending", tenantId: rt.tenantId, fields: { firstName: "Burst", lastName: "One", phone: "27829990099", email: `burst-${token}@test.invalid` }, now: new Date() })
    const res = await Promise.all(Array.from({ length: 25 }, () => send(fresh.conversationId, new Date())))
    expect(res.every((r) => r.status === 200)).toBe(true)
    expect(rt.ask).toHaveBeenCalledTimes(1)
    // Every message refused for the cap is kept for staff: none dropped, none for the model.
    const kept = await db.message.groupBy({ by: ["provider"], where: { conversationId: fresh.conversationId, direction: "INBOUND" }, _count: true })
    expect(kept).toEqual([{ provider: "MANUAL", _count: 25 }])
    // The hand-off reply is written, and sent back, once: by the call that opened the hand-off.
    expect(await db.message.count({ where: { conversationId: fresh.conversationId, bodyText: CLOSED_LINE } })).toBe(1)
    expect((await Promise.all(res.map((r) => r.json() as Promise<{ reply?: string }>))).filter((b) => b.reply === CLOSED_LINE)).toHaveLength(1)
    await db.message.deleteMany({ where: { conversationId: fresh.conversationId } })
    await db.conversation.delete({ where: { id: fresh.conversationId } })
  }, 60_000)

  it("a handed-off chat that keeps writing past the daily cap: kept for staff, no model call, no second hand-off reply, one note", async () => {
    const refused = await db.conversation.findFirstOrThrow({ where: { tenantId: rt.tenantId, status: "PENDING_INTERNAL" }, select: { id: true } })
    const res = await send(refused.id, new Date())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "fallback", staffName: null })
    expect(rt.ask).toHaveBeenCalledTimes(1)
    const msgs = await db.message.findMany({ where: { conversationId: refused.id }, orderBy: { createdAt: "asc" }, select: { direction: true, provider: true, bodyText: true } })
    // The question that triggered the hand-off and everything after it are for staff (MANUAL, bounded
    // by the staff-mode cap). The hand-off reply was sent once, by the call that opened it.
    expect(msgs.filter((m) => m.direction === "INBOUND").map((m) => [m.provider, m.bodyText])).toEqual([["MANUAL", "hi"], ["MANUAL", "hi"]])
    expect(msgs.filter((m) => m.bodyText === CLOSED_LINE)).toHaveLength(1)
    const notes = msgs.filter((m) => m.bodyText?.startsWith("Needs human"))
    expect(notes).toHaveLength(1)
    expect(notes[0].bodyText).toMatch(/^Needs human: the assistant's daily limit was reached, so the visitor's question above was not answered\. Call the visitor on \+2782\d{7}\.$/)
  }, 60_000)
})
