/**
 * Real route, real store, real Postgres, model mocked: what the assistant takes back
 * once staff hand a chat back. Messages written to staff are theirs: they do not use
 * up the assistant's per-chat allowance, and nothing said in staff mode (the visitor's
 * messages, staff lines, the join and leave lines) is ever sent to the model.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/after-staff.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const rt = vi.hoisted(() => ({ tenantId: "", ask: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => ({ id: rt.tenantId }) }))
vi.mock("@/lib/audit", () => ({ logAudit: async () => undefined, logAuditStrict: async () => undefined }))
vi.mock("@/lib/public-loan-products-server", () => ({ getLivePublicProductsServer: async () => [], getLivePricingServer: async () => ({}) }))
vi.mock("@/lib/website-chat/model", async (orig) => ({ ...(await orig<object>()), askAssistant: rt.ask }))

import { PrismaClient } from "@prisma/client"
import type { NextRequest } from "next/server"
import { POST } from "@/app/api/website/chat/message/route"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { MAX_VISITOR_MESSAGES, MAX_VISITOR_MESSAGES_WITH_STAFF } from "./constants"
import type { ChatTurn } from "./model"
import { joinChat, leaveChat, sendStaffChatReply } from "./staff"
import { startChat } from "./store"
import { issueChatToken } from "./token"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("the assistant after staff hand a chat back", () => {
  const db = new PrismaClient()
  const staff = `user_after_${token}`
  const saved = { secret: process.env.WEBSITE_CHAT_SECRET, key: process.env.ANTHROPIC_API_KEY, proxy: process.env.TRUSTED_PROXY }
  const send = async (conversationId: string, text: string) => {
    const res = await POST({ json: async () => ({ token: issueChatToken(conversationId, new Date()), text }), headers: new Headers() } as unknown as NextRequest)
    return { status: res.status, body: await res.json() }
  }
  const chat = async () => (await startChat({ brand: "Acme Lending", tenantId: rt.tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550006", email: `${randomUUID()}@test.invalid` }, now: new Date() })).conversationId
  // Open all day (beforeAll), so a cap hand-off waits for staff and says so.
  const CAP_LINE = "I can't help with that here, so I'll connect you to a consultant."
  const answer = (reply: string, needsHuman = false) => ({ reply, needsHuman, reason: needsHuman ? "asked_for_person" : null })
  const lastTurns = () => rt.ask.mock.calls.at(-1)?.[1] as ChatTurn[]

  beforeAll(async () => {
    process.env.WEBSITE_CHAT_SECRET = "x".repeat(40)
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.TRUSTED_PROXY = "1"
    rt.tenantId = `tenant_web_after_${token}`
    await db.tenant.create({ data: { id: rt.tenantId, slug: `web-after-${token}`, name: "Website chat after-staff IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    await db.user.create({ data: { id: staff, tenantId: rt.tenantId, email: `${staff}@test.invalid`, password: "x", name: "Thandi Mokoena", role: "ADMIN" } })
    const allDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: "00:00", close: "23:59" }]))
    await db.commsSettings.create({ data: { tenantId: rt.tenantId, businessHours: { tz: "Africa/Johannesburg", days: allDay } } })
  })

  beforeEach(() => {
    rt.ask.mockReset()
    // The per-chat request limit is not what these tests are about.
    _resetRateLimitStore()
  })

  afterAll(async () => {
    for (const [name, value] of [["WEBSITE_CHAT_SECRET", saved.secret], ["ANTHROPIC_API_KEY", saved.key], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    const where = { tenantId: rt.tenantId }
    await db.notification.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where })
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.commsSettings.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: rt.tenantId } })
    await db.tenant.delete({ where: { id: rt.tenantId } })
    await db.$disconnect()
  })

  it("messages written to staff do not use up the assistant's allowance: after a long staff chat the next question reaches the assistant", async () => {
    const id = await chat()
    rt.ask.mockResolvedValue(answer("An answer."))
    for (let i = 0; i < 15; i++) expect((await send(id, `question ${i}`)).status).toBe(200)
    rt.ask.mockResolvedValueOnce(answer("Passing you on.", true))
    expect((await send(id, "a person please")).body).toMatchObject({ handedOff: true, mode: "waiting" })
    expect(await joinChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })).toEqual({ ok: true })
    for (let i = 0; i < 10; i++) expect((await send(id, `to staff ${i}`)).body).toMatchObject({ mode: "staff" })
    expect(await leaveChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })).toEqual({ ok: true })
    // More visitor messages in the chat than the assistant's cap, but only 16 went to the assistant.
    expect(await db.message.count({ where: { conversationId: id, direction: "INBOUND" } })).toBeGreaterThan(MAX_VISITOR_MESSAGES)

    const calls = rt.ask.mock.calls.length
    rt.ask.mockResolvedValue(answer("Back with the assistant."))
    expect(await send(id, "one more question about fees")).toEqual({ status: 200, body: { reply: "Back with the assistant.", handedOff: false, mode: "bot" } })
    expect(rt.ask).toHaveBeenCalledTimes(calls + 1)
  }, 60_000)

  it("nothing said while staff held the chat is sent to the model afterwards; what the visitor still sees is unchanged", async () => {
    const id = await chat()
    rt.ask.mockResolvedValueOnce(answer("Passing you on.", true))
    await send(id, "I need a person")
    await joinChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })
    await send(id, "My ID number is 8001015009087, what is my balance?")
    expect((await sendStaffChatReply({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, text: "Your balance is R4,312.55, next debit 25 Oct.", now: new Date() })).ok).toBe(true)
    await leaveChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })

    rt.ask.mockResolvedValue(answer("I can't see accounts here."))
    await send(id, "what did you say my balance was?")
    const sent = JSON.stringify(lastTurns())
    for (const secret of ["8001015009087", "R4,312.55", "has joined the chat", "has left the chat", "Thandi"]) expect(sent).not.toContain(secret)
    expect(lastTurns().map((t) => t.text)).toEqual([
      expect.stringContaining("Hi Sipho"), "I need a person", "Passing you on.\n\nSure, I'll connect you to one of our consultants.", "what did you say my balance was?",
    ])
    // The visitor's window still shows the whole conversation.
    const shown = (await db.message.findMany({ where: { conversationId: id, direction: { in: ["INBOUND", "OUTBOUND"] } } })).map((m) => m.bodyText)
    for (const text of ["My ID number is 8001015009087, what is my balance?", "Your balance is R4,312.55, next debit 25 Oct."]) expect(shown).toContain(text)
  })

  it("in the fallback past the assistant's cap a message is kept for staff, once, with no model call and no repeated hand-off reply", async () => {
    const id = await chat()
    rt.ask.mockResolvedValue(answer("An answer."))
    for (let i = 0; i < MAX_VISITOR_MESSAGES; i++) expect((await send(id, `question ${i}`)).status).toBe(200)
    // The 21st opens the cap hand-off: the only call that says it is passing the visitor on. Its own
    // question is kept for staff, not dropped.
    expect(await send(id, "one more")).toEqual({ status: 429, body: { reply: CAP_LINE, handedOff: true, mode: "waiting" } })
    expect(await db.message.findMany({ where: { conversationId: id, bodyText: "one more" }, select: { direction: true, provider: true } })).toEqual([{ direction: "INBOUND", provider: "MANUAL" }])
    await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { timedOutAt: new Date() } })

    const calls = rt.ask.mock.calls.length
    const text = "Please call me on 0821234567 about my loan"
    expect(await send(id, text)).toEqual({ status: 200, body: { mode: "fallback", staffName: null } })
    expect(rt.ask).toHaveBeenCalledTimes(calls)
    const kept = await db.message.findMany({ where: { conversationId: id, bodyText: text } })
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ tenantId: rt.tenantId, channel: "CHATBOT", direction: "INBOUND", provider: "MANUAL", isInternal: false })
    // Staff see it in the thread; the hand-off reply was written once.
    expect((await db.conversation.findUniqueOrThrow({ where: { id } })).lastInboundAt).toEqual(kept[0].deliveredAt)
    expect(await db.message.count({ where: { conversationId: id, bodyText: CAP_LINE } })).toBe(1)
  }, 60_000)

  it("past the staff-mode cap the visitor is told the limit is reached, and the chat is not ended", async () => {
    const id = await chat()
    expect(await joinChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })).toEqual({ ok: true })
    await db.message.createMany({ data: Array.from({ length: MAX_VISITOR_MESSAGES_WITH_STAFF }, (_, i) => ({
      tenantId: rt.tenantId, conversationId: id, channel: "CHATBOT" as const, provider: "MANUAL" as const, direction: "INBOUND" as const, status: "DELIVERED" as const, bodyText: `m${i}`,
    })) })
    expect(await send(id, "and another")).toEqual({ status: 429, body: { mode: "staff", error: "You've reached the message limit for this chat. The consultant can still reply." } })
    // Handed back to the assistant past its own cap, in the fallback: the same answer, with that mode.
    await leaveChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })
    await db.conversation.update({ where: { id }, data: { status: "PENDING_INTERNAL" } })
    await db.message.createMany({ data: Array.from({ length: MAX_VISITOR_MESSAGES }, (_, i) => ({
      tenantId: rt.tenantId, conversationId: id, channel: "CHATBOT" as const, provider: "CHATBOT" as const, direction: "INBOUND" as const, status: "DELIVERED" as const, bodyText: `b${i}`,
    })) })
    expect(await send(id, "still there?")).toEqual({ status: 429, body: { mode: "fallback", error: "You've reached the message limit for this chat. Please use the WhatsApp button or wait for our call." } })
    expect(await db.message.count({ where: { conversationId: id, bodyText: { in: ["and another", "still there?"] } } })).toBe(0)
  })

  it("two messages racing at the assistant's cap: both kept for staff, one hand-off reply, and the loser told the mode without one", async () => {
    const id = await chat()
    await db.message.createMany({ data: Array.from({ length: MAX_VISITOR_MESSAGES }, (_, i) => ({
      tenantId: rt.tenantId, conversationId: id, channel: "CHATBOT" as const, provider: "CHATBOT" as const, direction: "INBOUND" as const, status: "DELIVERED" as const, bodyText: `asked ${i}`,
    })) })
    const [a, b] = await Promise.all([send(id, "racer one"), send(id, "racer two")])
    expect(rt.ask).not.toHaveBeenCalled()
    const replies = [a, b].filter((r) => r.body.reply === CAP_LINE)
    expect(replies).toHaveLength(1)
    expect(replies[0]).toEqual({ status: 429, body: { reply: CAP_LINE, handedOff: true, mode: "waiting" } })
    expect([a, b].find((r) => r !== replies[0])).toEqual({ status: 200, body: { mode: "waiting", staffName: null } })
    const kept = await db.message.findMany({ where: { conversationId: id, bodyText: { in: ["racer one", "racer two"] } }, select: { provider: true } })
    expect(kept).toEqual([{ provider: "MANUAL" }, { provider: "MANUAL" }])
    expect(await db.message.count({ where: { conversationId: id, bodyText: CAP_LINE } })).toBe(1)
  })
})
