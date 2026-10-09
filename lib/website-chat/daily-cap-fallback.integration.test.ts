/**
 * Real-Postgres proof of the daily cap: once the assistant is off for the day, what the
 * visitor writes is kept for staff (bounded by the staff-mode cap), never dropped and
 * never sent to the model, whether the chat is handed off already or not.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/daily-cap-fallback.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { DAILY_BOT_REPLY_CAP, MAX_VISITOR_MESSAGES_WITH_STAFF } from "./constants"
import { recordAssistantReply, recordVisitorMessage, startChat } from "./store"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("daily cap: kept for staff", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_web_daycap_fb_${token}`
  const now = new Date()
  const chat = async () => (await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550009", email: `${randomUUID()}@test.invalid` }, now })).conversationId
  const inbound = (conversationId: string, n: number, provider: "CHATBOT" | "MANUAL") => db.message.createMany({ data: Array.from({ length: n }, (_, i) => ({
    tenantId, conversationId, channel: "CHATBOT" as const, provider, direction: "INBOUND" as const, status: "DELIVERED" as const, bodyText: `f${i}`,
  })) })

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `web-daycap-fb-${token}`, name: "Website chat daily cap fallback IT", domain: null } })
    // Today's allowance used up by another chat.
    const filler = await chat()
    await inbound(filler, DAILY_BOT_REPLY_CAP, "CHATBOT")
    await db.conversation.update({ where: { id: filler }, data: { lastInboundAt: now, lastActivityAt: now } })
  }, 60_000)

  afterAll(async () => {
    const where = { tenantId }
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where })
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("a message in the fallback is kept for staff as MANUAL, up to the staff-mode cap", async () => {
    const id = await chat()
    await recordAssistantReply({ tenantId, conversationId: id, reply: "Passing you on.", needsHuman: true, reason: "out_of_scope", now })
    await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { timedOutAt: now } })
    const text = "Please call me on 0821234567"
    expect(await recordVisitorMessage({ tenantId, conversationId: id, text, now })).toEqual({ accepted: false, reason: "to_staff", stored: true })
    expect(await db.message.findMany({ where: { conversationId: id, direction: "INBOUND" }, select: { provider: true, bodyText: true } })).toEqual([{ provider: "MANUAL", bodyText: text }])
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toEqual(now)

    await inbound(id, MAX_VISITOR_MESSAGES_WITH_STAFF - 1, "MANUAL")
    expect(await recordVisitorMessage({ tenantId, conversationId: id, text: "over", now })).toEqual({ accepted: false, reason: "to_staff", stored: false })
    expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBe(MAX_VISITOR_MESSAGES_WITH_STAFF)
  }, 60_000)

  it("a chat still with the assistant: every message refused for the day is kept for staff, none for the model", async () => {
    const id = await chat()
    expect(await recordVisitorMessage({ tenantId, conversationId: id, text: "first", now })).toEqual({ accepted: false, reason: "daily_cap", stored: true })
    expect(await recordVisitorMessage({ tenantId, conversationId: id, text: "second", now })).toEqual({ accepted: false, reason: "daily_cap", stored: true })
    expect(await db.message.findMany({ where: { conversationId: id, direction: "INBOUND" }, select: { provider: true, bodyText: true }, orderBy: { createdAt: "asc" } }))
      .toEqual([{ provider: "MANUAL", bodyText: "first" }, { provider: "MANUAL", bodyText: "second" }])
  })
})
