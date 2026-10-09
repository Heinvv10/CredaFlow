/**
 * Real route, real store, real Postgres, model mocked: staff join a chat, or it is
 * handed off, while a visitor's message is in flight. The route's first read of the
 * mode is unlocked, so the store must decide again under the row lock.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/message-race.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const rt = vi.hoisted(() => ({ tenantId: "", ask: vi.fn(), afterLoad: null as null | (() => Promise<unknown>), beforeBell: null as null | (() => Promise<unknown>) }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: async () => ({ id: rt.tenantId }) }))
vi.mock("@/lib/audit", () => ({ logAudit: async () => undefined, logAuditStrict: async () => undefined }))
vi.mock("@/lib/public-loan-products-server", () => ({ getLivePublicProductsServer: async () => [], getLivePricingServer: async () => ({}) }))
vi.mock("@/lib/website-chat/model", async (orig) => ({ ...(await orig<object>()), askAssistant: rt.ask }))
// The real store, with a one-shot hook that runs right after the route's first loadChat.
vi.mock("@/lib/website-chat/store", async (orig) => {
  const real = await orig<typeof import("./store")>()
  return {
    ...real,
    loadChat: async (...a: Parameters<typeof real.loadChat>) => {
      const chat = await real.loadChat(...a)
      const hook = rt.afterLoad
      rt.afterLoad = null
      await hook?.()
      return chat
    },
  }
})

// The real bell, with a one-shot hook that runs after the hand-off committed and before staff are rung.
vi.mock("@/lib/website-chat/handoff", async (orig) => {
  const real = await orig<typeof import("./handoff")>()
  return {
    ...real,
    notifyStaffOfHandoff: async (a: Parameters<typeof real.notifyStaffOfHandoff>[0]) => {
      const hook = rt.beforeBell
      rt.beforeBell = null
      await hook?.()
      return real.notifyStaffOfHandoff(a)
    },
  }
})

import { PrismaClient } from "@prisma/client"
import type { NextRequest } from "next/server"
import { POST } from "@/app/api/website/chat/message/route"
import { POST as POLL } from "@/app/api/website/chat/poll/route"
import { joinChat, leaveChat } from "./staff"
import { recordAssistantReply, startChat } from "./store"
import { issueChatToken } from "./token"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("staff join while a visitor message is in flight", () => {
  const db = new PrismaClient()
  const staff = `user_race_${token}`
  const saved = { secret: process.env.WEBSITE_CHAT_SECRET, key: process.env.ANTHROPIC_API_KEY, proxy: process.env.TRUSTED_PROXY }
  const send = (conversationId: string, text: string) =>
    POST({ json: async () => ({ token: issueChatToken(conversationId, new Date()), text }), headers: new Headers() } as unknown as NextRequest)
  const join = (id: string) => db.conversation.update({ where: { id }, data: { assigneeId: staff } })
  const rows = async (id: string, direction: "INBOUND" | "OUTBOUND") =>
    (await db.message.findMany({ where: { conversationId: id, direction }, orderBy: { createdAt: "asc" } })).map((m) => m.bodyText)

  /** A chat in fallback: handed off, and the wait for staff timed out. */
  /** The hand-off line in hours (this suite's tenant is open all day), after the model's own text. */
  const LINE = "I can't help with that here, so I'll connect you to a consultant."

  async function fallbackChat(key: string) {
    const now = new Date()
    const r = await startChat({ brand: "Acme Lending", tenantId: rt.tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550003", email: `${key}-${token}@test.invalid` }, now })
    await recordAssistantReply({ tenantId: rt.tenantId, conversationId: r.conversationId, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now })
    await db.websiteChatHandoff.update({ where: { conversationId: r.conversationId }, data: { timedOutAt: now } })
    return { id: r.conversationId, greeting: r.greeting }
  }

  beforeAll(async () => {
    process.env.WEBSITE_CHAT_SECRET = "x".repeat(40)
    process.env.ANTHROPIC_API_KEY = "sk-test"
    process.env.TRUSTED_PROXY = "1"
    rt.tenantId = `tenant_web_race_${token}`
    await db.tenant.create({ data: { id: rt.tenantId, slug: `web-race-${token}`, name: "Website chat race IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    await db.user.create({ data: { id: staff, tenantId: rt.tenantId, email: `${staff}@test.invalid`, password: "x", name: "Thandi Mokoena", role: "ADMIN" } })
    // Open all week, so a hand-off here is a wait whatever the wall clock says.
    const allDay = Object.fromEntries(["mon", "tue", "wed", "thu", "fri", "sat", "sun"].map((d) => [d, { open: "00:00", close: "23:59" }]))
    await db.commsSettings.create({ data: { tenantId: rt.tenantId, businessHours: { tz: "Africa/Johannesburg", days: allDay } } })
  })

  beforeEach(() => {
    rt.ask.mockReset()
    rt.afterLoad = null
    rt.beforeBell = null
  })

  afterAll(async () => {
    for (const [name, value] of [["WEBSITE_CHAT_SECRET", saved.secret], ["ANTHROPIC_API_KEY", saved.key], ["TRUSTED_PROXY", saved.proxy]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    const where = { tenantId: rt.tenantId }
    await db.notification.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where }) // cascades WebsiteChatHandoff
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

  it("a join during the model call: the bot's answer is not written and not returned", async () => {
    const { id, greeting } = await fallbackChat("model")
    rt.ask.mockImplementation(async () => {
      await join(id)
      return { reply: "bot text", needsHuman: false, reason: null }
    })
    const res = await send(id, "Are you open on Saturday?")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "staff", staffName: "Thandi" })
    expect(rt.ask).toHaveBeenCalledOnce()
    // The question is kept for the person who joined; nothing from the bot follows it.
    expect(await rows(id, "INBOUND")).toEqual(["Are you open on Saturday?"])
    expect(await rows(id, "OUTBOUND")).toEqual([greeting, `I'll ask a consultant.\n\n${LINE}`])
  })

  it("a join between the route's read and the store call: kept for staff, the model is never called", async () => {
    const { id, greeting } = await fallbackChat("read")
    rt.afterLoad = () => join(id)
    const res = await send(id, "Hello?")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: "staff", staffName: "Thandi" })
    expect(rt.ask).not.toHaveBeenCalled()
    expect(await rows(id, "INBOUND")).toEqual(["Hello?"])
    expect(await rows(id, "OUTBOUND")).toEqual([greeting, `I'll ask a consultant.\n\n${LINE}`])
  })

  describe("a hand-off while another request is in flight", () => {
    const freshChat = async (key: string) =>
      (await startChat({ brand: "Acme Lending", tenantId: rt.tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550003", email: `${key}-${token}@test.invalid` }, now: new Date() })).conversationId
    const poll = async (conversationId: string) =>
      (await POLL({ json: async () => ({ token: issueChatToken(conversationId, new Date()) }), headers: new Headers() } as unknown as NextRequest)).json() as Promise<{ mode: string }>

    it("between the hand-off and the bell the chat is already waiting: a poll says so, and a message is kept for staff without a model call", async () => {
      const id = await freshChat("gap")
      let gapPoll: { mode?: string } = {}
      let gapMessage: unknown
      rt.ask.mockResolvedValueOnce({ reply: "Passing you to a consultant.", needsHuman: true, reason: "out_of_scope" })
      rt.ask.mockResolvedValue({ reply: "BOT ANSWER AFTER HAND-OFF", needsHuman: false, reason: null })
      rt.beforeBell = async () => {
        gapPoll = await poll(id)
        gapMessage = await (await send(id, "second message, sent in the gap")).json()
      }
      const first = await (await send(id, "I want to talk to a person")).json()

      expect(first).toEqual({ reply: `Passing you to a consultant.\n\n${LINE}`, handedOff: true, mode: "waiting" })
      expect(gapPoll.mode).toBe("waiting")
      expect(gapMessage).toEqual({ mode: "waiting", staffName: null })
      expect(rt.ask).toHaveBeenCalledTimes(1)
      expect(await rows(id, "INBOUND")).toEqual(["I want to talk to a person", "second message, sent in the gap"])
      expect((await rows(id, "OUTBOUND")).at(-1)).toBe(`Passing you to a consultant.\n\n${LINE}`)
      expect(await db.notification.count({ where: { tenantId: rt.tenantId, type: "CHAT_HANDOFF", entityId: id } })).toBe(1)
    })

    it("a model call already running when the hand-off opens writes nothing, and its request reports the wait", async () => {
      const id = await freshChat("in-flight")
      let release!: () => void
      const gate = new Promise<void>((done) => { release = done })
      rt.ask.mockImplementationOnce(async () => { await gate; return { reply: "SLOW BOT ANSWER", needsHuman: false, reason: null } })
      rt.ask.mockResolvedValueOnce({ reply: "Passing you on.", needsHuman: true, reason: "out_of_scope" })
      const slow = send(id, "question one")
      // Until the slow request has stored its question and is inside the model call.
      await vi.waitFor(() => expect(rt.ask).toHaveBeenCalledTimes(1))
      const fast = await (await send(id, "get me a human")).json()
      expect(fast).toMatchObject({ reply: `Passing you on.\n\n${LINE}`, mode: "waiting" })
      release()

      expect(await (await slow).json()).toEqual({ mode: "waiting", staffName: null })
      const out = await rows(id, "OUTBOUND")
      expect(out).not.toContain("SLOW BOT ANSWER")
      expect(out.at(-1)).toBe(`Passing you on.\n\n${LINE}`)
    })

    it.each([
      ["half a surrogate pair", "hi \uD83D there", "hi  there"],
      ["a NUL", "a\u0000b", "ab"],
    ])("a message with %s is stored clean, not refused by the database", async (key, sent, clean) => {
      const id = await freshChat(`hostile-${key.replaceAll(" ", "-")}`)
      rt.ask.mockResolvedValue({ reply: "ok", needsHuman: false, reason: null })
      const res = await send(id, sent)
      expect(res.status).toBe(200)
      expect(await rows(id, "INBOUND")).toEqual([clean])
    })
  })

  describe("staff leave, or the chat closes, while a message is in flight", () => {
    const fresh = async (key: string) =>
      (await startChat({ brand: "Acme Lending", tenantId: rt.tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550003", email: `${key}-${token}@test.invalid` }, now: new Date() })).conversationId

    it("a leave between the route's read and the store call: the message goes to the assistant, which answers it", async () => {
      const id = await fresh("left-meanwhile")
      expect(await joinChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })).toEqual({ ok: true })
      rt.afterLoad = () => leaveChat({ tenantId: rt.tenantId, conversationId: id, staffUserId: staff, now: new Date() })
      rt.ask.mockResolvedValue({ reply: "Our rates are on /site/calculators.", needsHuman: false, reason: null })
      const res = await send(id, "What is the interest rate?")
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reply: "Our rates are on /site/calculators.", handedOff: false, mode: "bot" })
      expect(rt.ask).toHaveBeenCalledOnce()
      const stored = await db.message.findFirstOrThrow({ where: { conversationId: id, direction: "INBOUND" } })
      expect(stored).toMatchObject({ bodyText: "What is the interest rate?", provider: "CHATBOT" })
      expect((await rows(id, "OUTBOUND")).at(-1)).toBe("Our rates are on /site/calculators.")
    })

    it.each([
      ["closed", false],
      ["joined and closed", true],
    ])("a chat %s during the model call gets no bot reply, and the visitor is told it ended", async (_name, joinFirst) => {
      const id = await fresh(`closed-${joinFirst}`)
      rt.ask.mockImplementation(async () => {
        if (joinFirst) await join(id)
        await db.conversation.update({ where: { id }, data: { status: "CLOSED", closedAt: new Date() } })
        return { reply: "bot text", needsHuman: false, reason: null }
      })
      const res = await send(id, "Are you open on Saturday?")
      expect(await res.json()).toEqual({ mode: "ended", staffName: null })
      expect(await db.message.count({ where: { conversationId: id, bodyText: "bot text" } })).toBe(0)
    })
  })
})
