/**
 * Real-Postgres proof of the staff side of a website chat: the join that only one
 * person can win, the disclosure line the visitor sees, and replies only the
 * person who joined may send.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/staff.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { countUnansweredConversations } from "@/lib/inbox/unanswered"
import { expireHandoffIfDue } from "./handoff"
import { HANDOFF_WAIT_MS } from "./mode"
import { MAX_STAFF_REPLY_CHARS } from "./constants"
import { joinChat, sendStaffChatReply } from "./staff"
import { recordAssistantReply, recordVisitorMessage, startChat } from "./store"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("website chat staff join and reply", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_web_join_${token}`
  const other = `tenant_web_join2_${token}`
  const tenants = [tenantId, other]
  const staff = Array.from({ length: 10 }, (_, i) => `user_join${i}_${token}`)
  const [thandi, lwazi] = staff
  const nameless = `user_join_nameless_${token}`
  const blank = `user_join_blank_${token}`
  const t0 = new Date("2026-09-29T10:00:00Z")
  const at = (min: number) => new Date(t0.getTime() + min * 60_000)
  const JOINED = "Thandi from Acme Lending has joined the chat."

  async function chat(key: string, tenant = tenantId) {
    return (await startChat({ brand: "Acme Lending", tenantId: tenant, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550003", email: `${key}-${token}@test.invalid` }, now: t0 })).conversationId
  }
  const join = (conversationId: string, staffUserId = thandi, now = at(1)) => joinChat({ tenantId, conversationId, staffUserId, staffEmail: `${staffUserId}@test.invalid`, now })
  const thread = (id: string) => db.conversation.findUniqueOrThrow({ where: { id }, select: { assigneeId: true, status: true, lastOutboundAt: true, lastActivityAt: true } })
  /** Everything staff have written into the thread (the bot's rows have no author). */
  const staffRows = (conversationId: string) => db.message.findMany({ where: { conversationId, createdById: { not: null } }, orderBy: { createdAt: "asc" } })
  const audits = (conversationId: string) => db.auditLog.findMany({ where: { entityId: conversationId }, orderBy: { createdAt: "asc" } })
  const untouched = { assigneeId: null, status: "OPEN", lastOutboundAt: t0, lastActivityAt: t0 }

  /** Runs `fn` while a throwaway-DB-only trigger rejects writes for one thread, then drops it. */
  async function whileRejecting(kind: "audit" | "commit", conversationId: string, fn: () => Promise<unknown>) {
    const name = `wc_join_${kind}_${randomUUID().replaceAll("-", "")}`
    const column = kind === "audit" ? `"entityId"` : "id"
    await db.$executeRawUnsafe(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.${column} = '${conversationId}' THEN RAISE EXCEPTION '${kind} refused'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe(kind === "audit"
      ? `CREATE TRIGGER ${name} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${name}()`
      : `CREATE CONSTRAINT TRIGGER ${name} AFTER UPDATE ON "Conversation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${name}()`)
    try {
      // allSettled: Prisma 5.22's interactive $transaction RESOLVES when COMMIT is rejected.
      // The committed outcome is what the caller asserts.
      return (await Promise.allSettled([fn()]))[0]
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${name} ON "${kind === "audit" ? "AuditLog" : "Conversation"}"`)
      await db.$executeRawUnsafe(`DROP FUNCTION ${name}()`)
    }
  }

  beforeAll(async () => {
    for (const id of tenants) await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat join IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    const names = ["Thandi Mokoena", "  Lwazi   Nkosi "]
    for (const [i, id] of staff.entries()) await db.user.create({ data: { id, tenantId, email: `${id}@test.invalid`, password: "x", name: names[i] ?? `Staff${i} Member` } })
    await db.user.create({ data: { id: nameless, tenantId, email: `${nameless}@test.invalid`, password: "x", name: null } })
    await db.user.create({ data: { id: blank, tenantId, email: `${blank}@test.invalid`, password: "x", name: "   " } })
  })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await db.auditLog.deleteMany({ where })
    await db.notification.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where }) // cascades WebsiteChatHandoff
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: { in: tenants } } })
    await db.tenant.deleteMany({ where: { id: { in: tenants } } })
    await db.$disconnect()
  })

  describe("joinChat", () => {
    it("assigns the chat, tells the visitor who joined, stamps the thread and audits it", async () => {
      const id = await chat("join")
      expect(await join(id)).toEqual({ ok: true })

      expect(await thread(id)).toEqual({ assigneeId: thandi, status: "OPEN", lastOutboundAt: at(1), lastActivityAt: at(1) })
      const rows = await staffRows(id)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tenantId, channel: "CHATBOT", direction: "OUTBOUND", provider: "MANUAL", createdById: thandi,
        status: "DELIVERED", sentAt: at(1), deliveredAt: at(1), isInternal: false, bodyText: JOINED,
      })
      const log = await audits(id)
      expect(log).toHaveLength(1)
      expect(log[0]).toMatchObject({
        tenantId, userId: thandi, userEmail: `${thandi}@test.invalid`, action: "WEBSITE_CHAT_STAFF_JOINED",
        entity: "Conversation", newValue: { assigneeId: thandi },
      })
    })

    it("uses the first word of the staff name, and a neutral line when there is no name", async () => {
      const line = async (key: string, staffUserId: string) => {
        const id = await chat(key)
        expect(await join(id, staffUserId)).toEqual({ ok: true })
        return (await staffRows(id))[0].bodyText
      }
      expect(await line("name-padded", lwazi)).toBe("Lwazi from Acme Lending has joined the chat.")
      expect(await line("name-null", nameless)).toBe("A consultant from Acme Lending has joined the chat.")
      expect(await line("name-blank", blank)).toBe("A consultant from Acme Lending has joined the chat.")
    })

    it("joining answers the hand-off, waiting or timed out: status OPEN, the row gone, its bell items read, off the unanswered badge", async () => {
      for (const timedOutAt of [null, at(3)]) {
        const id = await chat(`pending-${timedOutAt ? "fallback" : "waiting"}`)
        const elsewhere = await chat(`pending-other-${timedOutAt ? "fallback" : "waiting"}`)
        await recordAssistantReply({ tenantId, conversationId: id, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: at(1) })
        await db.websiteChatHandoff.update({ where: { conversationId: id }, data: { timedOutAt } })
        const item = (userId: string, type: string, entityId: string) => db.notification.create({ data: { tenantId, userId, type, title: "t", entityType: "Conversation", entityId } })
        const read = async (rows: { id: string }[]) => (await db.notification.findMany({ where: { id: { in: rows.map((n) => n.id) } } })).map((n) => n.readAt)
        const mine = [await item(thandi, "CHAT_HANDOFF", id), await item(lwazi, "CHAT_HANDOFF", id)]
        const others = [await item(thandi, "CHAT_HANDOFF", elsewhere), await item(thandi, "COMMS_MENTION", id)]
        const owed = await countUnansweredConversations(tenantId)

        expect(await join(id, thandi, at(4))).toEqual({ ok: true })
        expect([await thread(id), await db.websiteChatHandoff.count({ where: { conversationId: id } })]).toMatchObject([{ assigneeId: thandi, status: "OPEN" }, 0])
        expect([await read(mine), await read(others)]).toEqual([[at(4), at(4)], [null, null]])
        expect(await countUnansweredConversations(tenantId)).toBe(owed - 1)
      }
    })

    it("lets exactly one of ten staff joining at once win", async () => {
      const id = await chat("race")
      const results = await Promise.all(staff.map((u) => join(id, u)))

      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect(results.filter((r) => !r.ok)).toEqual(Array(9).fill({ ok: false, reason: "ALREADY_CLAIMED" }))
      const winner = staff[results.findIndex((r) => r.ok)]
      expect((await thread(id)).assigneeId).toBe(winner)
      const rows = await staffRows(id)
      expect(rows.map((m) => m.createdById)).toEqual([winner])
      const log = await audits(id)
      expect(log.map((a) => [a.action, a.userId])).toEqual([["WEBSITE_CHAT_STAFF_JOINED", winner]])
    })

    it("refuses a thread that is not an open website chat of this tenant, and changes nothing", async () => {
      const contact = await db.contact.create({ data: { tenantId, status: "LEAD", firstSeenChannel: "WHATSAPP", firstName: "wa" } })
      const whatsApp = (await db.conversation.create({ data: { tenantId, contactId: contact.id, channel: "WHATSAPP", status: "OPEN" } })).id
      const elsewhere = await chat("other-tenant", other)
      const closed = await chat("closed")
      await db.conversation.update({ where: { id: closed }, data: { status: "CLOSED", closedAt: at(1) } })

      for (const id of [whatsApp, elsewhere, closed, `missing_${token}`]) expect(await join(id)).toEqual({ ok: false, reason: "NOT_FOUND" })
      for (const id of [whatsApp, elsewhere, closed]) {
        expect((await thread(id)).assigneeId).toBeNull()
        expect(await staffRows(id)).toEqual([])
        expect(await audits(id)).toEqual([])
      }
      expect(await thread(elsewhere)).toEqual(untouched)
    })

    it("if the audit row cannot be written the chat stays unassigned, still waiting, and the visitor is told nothing", async () => {
      const id = await chat("audit-fails")
      await recordAssistantReply({ tenantId, conversationId: id, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: t0 })
      // Refused mid-transaction, not at commit: the caller must hear about it too.
      expect((await whileRejecting("audit", id, () => join(id))).status).toBe("rejected")
      expect([await thread(id), await db.websiteChatHandoff.count({ where: { conversationId: id } })]).toEqual([{ ...untouched, status: "PENDING_INTERNAL" }, 1])
      expect(await staffRows(id)).toEqual([])
    })

    it("if the join fails at commit, after its audit row was written, no audit row survives", async () => {
      const id = await chat("commit-fails")
      await whileRejecting("commit", id, () => join(id))
      expect(await thread(id)).toEqual(untouched)
      expect(await staffRows(id)).toEqual([])
      expect(await audits(id)).toEqual([])
    })

    it("once joined, visitor messages go to staff, the bot is silenced and the wait never expires", async () => {
      const id = await chat("tie-in")
      await recordAssistantReply({ tenantId, conversationId: id, reply: "I'll ask a consultant.", needsHuman: true, reason: "out_of_scope", now: at(1) })
      expect(await join(id, thandi, at(2))).toEqual({ ok: true })

      expect(await recordVisitorMessage({ tenantId, conversationId: id, text: "Hello Thandi", now: at(3) })).toEqual({ accepted: false, reason: "to_staff", stored: true })
      expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "bot text", needsHuman: false, reason: null, now: at(3) })).toEqual({ handedOffNow: false, suppressed: true })
      expect(await expireHandoffIfDue({ tenantId, conversationId: id, now: new Date(at(1).getTime() + HANDOFF_WAIT_MS + 60_000) })).toBe(false)
      expect(await db.message.count({ where: { conversationId: id, bodyText: "bot text" } })).toBe(0)
    })
  })

  describe("sendStaffChatReply", () => {
    const reply = (conversationId: string, staffUserId = thandi, tenant = tenantId) => sendStaffChatReply({ tenantId: tenant, conversationId, staffUserId, text: "Your ID and a payslip.", now: at(5) })
    async function joined(key: string) {
      const id = await chat(key)
      await join(id)
      return id
    }
    const onlyTheJoin = async (id: string) => {
      expect((await staffRows(id)).map((m) => m.bodyText)).toEqual([JOINED])
      expect((await audits(id)).map((a) => a.action)).toEqual(["WEBSITE_CHAT_STAFF_JOINED"])
      expect(await thread(id)).toMatchObject({ lastOutboundAt: at(1), lastActivityAt: at(1) })
    }

    it("writes the reply as the person who joined, stamps the thread and audits the message id, never the text", async () => {
      const id = await joined("reply")
      const r = await reply(id)
      if (!r.ok) throw new Error(`expected ok, got ${r.reason}`)

      const rows = await staffRows(id)
      expect(rows.map((m) => m.id)).toEqual([rows[0].id, r.message.id])
      expect(rows[1]).toMatchObject({
        tenantId, channel: "CHATBOT", direction: "OUTBOUND", provider: "MANUAL", createdById: thandi,
        status: "DELIVERED", sentAt: at(5), deliveredAt: at(5), isInternal: false, bodyText: "Your ID and a payslip.",
      })
      expect(r.message).toEqual(rows[1])
      expect(await thread(id)).toMatchObject({ assigneeId: thandi, lastOutboundAt: at(5), lastActivityAt: at(5) })
      const [, audit] = await audits(id)
      expect(audit).toMatchObject({ tenantId, userId: thandi, action: "WEBSITE_CHAT_STAFF_REPLY", entity: "Conversation", newValue: { messageId: r.message.id } })
      expect(JSON.stringify(audit)).not.toContain("payslip")
    })

    it("refuses anyone but the person who joined, and writes nothing", async () => {
      const id = await joined("not-joined")
      expect(await reply(id, lwazi)).toEqual({ ok: false, reason: "NOT_JOINED" })
      await onlyTheJoin(id)

      const nobody = await chat("nobody-joined")
      expect(await reply(nobody)).toEqual({ ok: false, reason: "NOT_JOINED" })
      expect(await staffRows(nobody)).toEqual([])
      expect(await audits(nobody)).toEqual([])
    })

    it("refuses a closed chat, another tenant's chat and a thread that is not a website chat", async () => {
      const closed = await joined("reply-closed")
      await db.conversation.update({ where: { id: closed }, data: { status: "CLOSED", closedAt: at(4) } })
      expect(await reply(closed)).toEqual({ ok: false, reason: "CLOSED" })
      await onlyTheJoin(closed)

      const mine = await joined("reply-tenant")
      expect(await reply(mine, thandi, other)).toEqual({ ok: false, reason: "CONVERSATION_NOT_FOUND" })
      await onlyTheJoin(mine)

      const contact = await db.contact.create({ data: { tenantId, status: "LEAD", firstSeenChannel: "WHATSAPP", firstName: "wa2" } })
      const whatsApp = (await db.conversation.create({ data: { tenantId, contactId: contact.id, channel: "WHATSAPP", status: "OPEN", assigneeId: thandi } })).id
      expect(await reply(whatsApp)).toEqual({ ok: false, reason: "CONVERSATION_NOT_FOUND" })
      expect(await staffRows(whatsApp)).toEqual([])
    })

    it("a retried reply with the same key is written once, audited once and returns the same message", async () => {
      const id = await joined("reply-retry")
      const send = (idempotencyKey: string) => sendStaffChatReply({ tenantId, conversationId: id, staffUserId: thandi, text: "Same text", now: at(5), idempotencyKey })
      const idOf = (r: Awaited<ReturnType<typeof send>>) => { if (!r.ok) throw new Error(`expected ok, got ${r.reason}`); return r.message.id }
      const count = async () => [(await staffRows(id)).length - 1, (await audits(id)).filter((a) => a.action === "WEBSITE_CHAT_STAFF_REPLY").length]

      const first = idOf(await send(`k1-${token}`))
      expect(idOf(await send(`k1-${token}`))).toBe(first)
      expect(await count()).toEqual([1, 1])

      const burst = await Promise.all(Array.from({ length: 5 }, () => send(`k2-${token}`)))
      expect(new Set(burst.map(idOf)).size).toBe(1)
      expect(idOf(burst[0])).not.toBe(first)
      expect(await count()).toEqual([2, 2])

      // A different key with the same text is a new reply.
      expect([first, idOf(burst[0])]).not.toContain(idOf(await send(`k3-${token}`)))
      expect(await count()).toEqual([3, 3])

      // The key belongs to the chat it was used on: it does not hand another chat's message back.
      const elsewhere = await joined("reply-retry-other")
      const reused = await Promise.allSettled([sendStaffChatReply({ tenantId, conversationId: elsewhere, staffUserId: thandi, text: "Same text", now: at(5), idempotencyKey: `k1-${token}` })])
      expect(reused[0].status).toBe("rejected")
      await onlyTheJoin(elsewhere)
    })

    it("refuses an empty reply and one over the length limit for any caller, and writes nothing", async () => {
      const id = await joined("reply-long")
      const send = (n: number) => sendStaffChatReply({ tenantId, conversationId: id, staffUserId: thandi, text: "x".repeat(n), now: at(5) })
      expect(await send(MAX_STAFF_REPLY_CHARS + 1)).toEqual({ ok: false, reason: "TOO_LONG" })
      for (const text of ["", " \n\t "]) expect(await sendStaffChatReply({ tenantId, conversationId: id, staffUserId: thandi, text, now: at(5) })).toEqual({ ok: false, reason: "EMPTY" })
      await onlyTheJoin(id)
      expect((await send(MAX_STAFF_REPLY_CHARS)).ok).toBe(true)
    })

    it("a reply whose audit row cannot be written, or that fails at commit, leaves no message and no audit row", async () => {
      for (const kind of ["audit", "commit"] as const) {
        const id = await joined(`reply-${kind}-fails`)
        const settled = await whileRejecting(kind, id, () => reply(id))
        if (kind === "audit") expect(settled.status).toBe("rejected")
        await onlyTheJoin(id)
      }
    })
  })
})
