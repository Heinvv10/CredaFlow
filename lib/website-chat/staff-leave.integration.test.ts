/**
 * Real-Postgres proof that a takeover is always visible in the stored transcript:
 * leaving writes a line, a website chat cannot be handed over silently, a name from
 * another tenant is never shown, and a retried reply survives a close or a release.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/staff-leave.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_web_leave_${token}`
const session = vi.hoisted(() => ({ userId: "", role: "CREDIT_OFFICER" }))

// The route's own guard and tenant resolver need a session and a request host; everything below them is real.
vi.mock("@/lib/inbox/authz", () => ({ requireCommsAgent: async () => ({ user: { id: session.userId, email: `${session.userId}@test.invalid`, role: session.role } }) }))
vi.mock("@/lib/tenant", async () => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return { withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => runWithTenant(tenantId, () => cb({ id: tenantId })) }
})

import { POST } from "@/app/api/inbox/conversations/[id]/assignment/route"
import { joinChat, leaveChat, sendStaffChatReply } from "./staff"
import { loadChat, recordAssistantReply, startChat } from "./store"

suite("website chat staff leave", () => {
  const db = new PrismaClient()
  const other = `tenant_web_leave2_${token}`
  const tenants = [tenantId, other]
  const thandi = `user_leave_a_${token}`
  const lwazi = `user_leave_b_${token}`
  const outsider = `user_leave_x_${token}`
  const t0 = new Date("2026-09-29T10:00:00Z")
  const at = (min: number) => new Date(t0.getTime() + min * 60_000)
  const JOINED = "Thandi from Acme Lending has joined the chat."
  const LEFT = "Thandi from Acme Lending has left the chat."

  async function chat(key: string) {
    return (await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550004", email: `${key}-${token}@test.invalid` }, now: t0 })).conversationId
  }
  const join = (conversationId: string, staffUserId = thandi, now = at(1)) => joinChat({ tenantId, conversationId, staffUserId, now })
  const leave = (conversationId: string, staffUserId = thandi, now = at(2)) => leaveChat({ tenantId, conversationId, staffUserId, staffEmail: `${staffUserId}@test.invalid`, now })
  const thread = (id: string) => db.conversation.findUniqueOrThrow({ where: { id }, select: { assigneeId: true, lastOutboundAt: true, lastActivityAt: true } })
  const status = async (id: string) => (await db.conversation.findUniqueOrThrow({ where: { id } })).status
  const staffLines = async (conversationId: string) => (await db.message.findMany({ where: { conversationId, createdById: { not: null } }, orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }] })).map((m) => m.bodyText)
  const actions = async (conversationId: string) => (await db.auditLog.findMany({ where: { entityId: conversationId }, orderBy: { createdAt: "asc" } })).map((a) => a.action)
  const route = async (conversationId: string, userId: string, body: object, role = "CREDIT_OFFICER") => {
    session.userId = userId
    session.role = role
    const res = await POST(new NextRequest(`http://x/api/inbox/conversations/${conversationId}/assignment`, { method: "POST", body: JSON.stringify(body) }), { params: Promise.resolve({ id: conversationId }) })
    return { status: res.status, body: await res.json() }
  }

  beforeAll(async () => {
    for (const id of tenants) await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat leave IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    const user = (id: string, name: string, tenant = tenantId) => db.user.create({ data: { id, tenantId: tenant, email: `${id}@test.invalid`, password: "x", name } })
    await user(thandi, "Thandi Mokoena")
    await user(lwazi, "Lwazi Nkosi")
    await user(outsider, "Zanele Khumalo", other)
  })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await db.auditLog.deleteMany({ where })
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where })
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: { in: tenants } } })
    await db.tenant.deleteMany({ where: { id: { in: tenants } } })
    await db.$disconnect()
  })

  it("leaving unassigns the chat, tells the visitor, stamps the thread and audits it", async () => {
    const id = await chat("leave")
    await join(id)
    expect(await leave(id)).toEqual({ ok: true })

    expect(await thread(id)).toEqual({ assigneeId: null, lastOutboundAt: at(2), lastActivityAt: at(2) })
    // Back with the assistant: open, and no hand-off left over for the sweep to act on.
    expect(await status(id)).toBe("OPEN")
    expect(await db.websiteChatHandoff.count({ where: { conversationId: id } })).toBe(0)
    expect((await loadChat(tenantId, id))?.mode).toBe("bot")
    const rows = await db.message.findMany({ where: { conversationId: id, bodyText: { endsWith: "has left the chat." } } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      tenantId, channel: "CHATBOT", direction: "OUTBOUND", provider: "MANUAL", createdById: thandi,
      status: "DELIVERED", sentAt: at(2), deliveredAt: at(2), isInternal: false, bodyText: LEFT,
    })
    const log = await db.auditLog.findMany({ where: { entityId: id, action: "WEBSITE_CHAT_STAFF_LEFT" } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ tenantId, userId: thandi, userEmail: `${thandi}@test.invalid`, entity: "Conversation", oldValue: { assigneeId: thandi } })

    // Already gone: a second leave is refused and writes nothing more.
    expect(await leave(id)).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
    expect(await staffLines(id)).toEqual([JOINED, LEFT])
  })

  it("only the person who joined can leave: anyone else, another tenant or another channel changes nothing", async () => {
    const id = await chat("leave-other")
    await join(id)
    expect(await leave(id, lwazi)).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
    expect(await leaveChat({ tenantId: other, conversationId: id, staffUserId: thandi, now: at(2) })).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
    expect(await thread(id)).toEqual({ assigneeId: thandi, lastOutboundAt: at(1), lastActivityAt: at(1) })
    expect(await staffLines(id)).toEqual([JOINED])
    expect(await actions(id)).toEqual(["WEBSITE_CHAT_STAFF_JOINED"])

    const contact = await db.contact.create({ data: { tenantId, status: "LEAD", firstSeenChannel: "WHATSAPP", firstName: "wa" } })
    const whatsApp = (await db.conversation.create({ data: { tenantId, contactId: contact.id, channel: "WHATSAPP", status: "OPEN", assigneeId: thandi } })).id
    expect(await leave(whatsApp)).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
    expect((await thread(whatsApp)).assigneeId).toBe(thandi)
    expect(await staffLines(whatsApp)).toEqual([])
  })

  it("an admin can release a colleague's chat: the line names the colleague, the audit row names the admin", async () => {
    const id = await chat("leave-admin")
    await join(id)
    expect(await leaveChat({ tenantId, conversationId: id, staffUserId: lwazi, staffEmail: "lwazi@test.invalid", asAdmin: true, now: at(2) })).toEqual({ ok: true })

    expect((await thread(id)).assigneeId).toBeNull()
    const lines = await db.message.findMany({ where: { conversationId: id, createdById: { not: null } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
    expect(lines.map((m) => [m.createdById, m.bodyText])).toEqual([[thandi, JOINED], [thandi, LEFT]])
    const log = await db.auditLog.findMany({ where: { entityId: id, action: "WEBSITE_CHAT_STAFF_LEFT" } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ userId: lwazi, userEmail: "lwazi@test.invalid", oldValue: { assigneeId: thandi }, newValue: { assigneeId: null } })
  })

  it("an admin releasing a chat nobody holds, or one of another tenant, changes nothing", async () => {
    const id = await chat("leave-admin-none")
    expect(await leaveChat({ tenantId, conversationId: id, staffUserId: lwazi, asAdmin: true, now: at(2) })).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
    await join(id)
    expect(await leaveChat({ tenantId: other, conversationId: id, staffUserId: outsider, asAdmin: true, now: at(2) })).toEqual({ ok: false, reason: "NOT_ASSIGNED_TO_YOU" })
    expect((await thread(id)).assigneeId).toBe(thandi)
    expect(await staffLines(id)).toEqual([JOINED])
    expect(await actions(id)).toEqual(["WEBSITE_CHAT_STAFF_JOINED"])
  })

  it("leaving, or an admin releasing, a chat staff set pending by hand puts it back to OPEN, so the next hand-off flips and opens a wait", async () => {
    for (const [key, by] of [["self", thandi], ["admin", lwazi]] as const) {
      const id = await chat(`leave-pending-${key}`)
      await join(id)
      await db.conversation.update({ where: { id }, data: { status: "PENDING_INTERNAL" } })
      expect(await leaveChat({ tenantId, conversationId: id, staffUserId: by, asAdmin: by === lwazi, now: at(2) })).toEqual({ ok: true })
      expect(await status(id)).toBe("OPEN")
      expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "Passing you on.", needsHuman: true, reason: "complaint", now: at(3) }))
        .toMatchObject({ handedOffNow: true })
      expect(await db.websiteChatHandoff.count({ where: { conversationId: id } })).toBe(1)
    }
  })

  it("if the leave fails at commit, after its line and audit row were written, the chat stays held and neither survives", async () => {
    const id = await chat("leave-commit")
    await join(id)
    const fn = `wc_leave_commit_${token}`
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id = '${id}' THEN RAISE EXCEPTION 'commit refused'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER ${fn} AFTER UPDATE ON "Conversation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    try {
      // allSettled: Prisma 5.22's interactive $transaction RESOLVES when COMMIT is rejected; the committed state is what counts.
      await Promise.allSettled([leave(id)])
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "Conversation"`)
      await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
    expect((await thread(id)).assigneeId).toBe(thandi)
    expect(await staffLines(id)).toEqual([JOINED])
    expect(await actions(id)).toEqual(["WEBSITE_CHAT_STAFF_JOINED"])
  })

  it("a closed chat can still be left", async () => {
    const id = await chat("leave-closed")
    await join(id)
    await db.conversation.update({ where: { id }, data: { status: "CLOSED", closedAt: at(2) } })
    expect(await leave(id, thandi, at(3))).toEqual({ ok: true })
    expect((await thread(id)).assigneeId).toBeNull()
    expect(await status(id)).toBe("CLOSED")
    expect(await staffLines(id)).toEqual([JOINED, LEFT])
  })

  it("if the audit row cannot be written the chat stays assigned and no line is written", async () => {
    const id = await chat("leave-audit")
    await join(id)
    const fn = `wc_leave_audit_${token}`
    await db.$executeRawUnsafe(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW."entityId" = '${id}' THEN RAISE EXCEPTION 'audit refused'; END IF; RETURN NEW; END $$`)
    await db.$executeRawUnsafe(`CREATE TRIGGER ${fn} BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION ${fn}()`)
    try {
      expect((await Promise.allSettled([leave(id)]))[0].status).toBe("rejected")
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER ${fn} ON "AuditLog"`)
      await db.$executeRawUnsafe(`DROP FUNCTION ${fn}()`)
    }
    expect((await thread(id)).assigneeId).toBe(thandi)
    expect(await staffLines(id)).toEqual([JOINED])
  })

  it("a staff id from another tenant never has its name written into this tenant's transcript", async () => {
    const id = await chat("outsider")
    expect(await join(id, outsider)).toEqual({ ok: true })
    expect(await leave(id, outsider)).toEqual({ ok: true })
    expect(await staffLines(id)).toEqual(["A consultant from Acme Lending has joined the chat.", "A consultant from Acme Lending has left the chat."])
    // Nor is it sent to the visitor's window as the label of those lines.
    expect((await loadChat(tenantId, id))?.lines.filter((l) => l.from === "staff").map((l) => l.name)).toEqual(["Consultant", "Consultant"])
  })

  it("a retried reply returns the stored message after the chat was released, and after it was closed", async () => {
    for (const [key, end] of [["released", (id: string) => leave(id, thandi, at(6))], ["closed", (id: string) => db.conversation.update({ where: { id }, data: { status: "CLOSED", closedAt: at(6) } })]] as const) {
      const id = await chat(`retry-${key}`)
      await join(id)
      const send = (idempotencyKey: string) => sendStaffChatReply({ tenantId, conversationId: id, staffUserId: thandi, staffEmail: "thandi@test.invalid", text: "On its way.", now: at(5), idempotencyKey })
      const first = await send(`${key}-${token}`)
      if (!first.ok) throw new Error(first.reason)
      await end(id)

      const retry = await send(`${key}-${token}`)
      expect(retry).toEqual({ ok: true, message: first.message })
      // A new reply is still refused: only the stored one is handed back.
      expect(await send(`${key}-new-${token}`)).toEqual({ ok: false, reason: key === "closed" ? "CLOSED" : "NOT_JOINED" })
      expect(await db.message.count({ where: { conversationId: id, bodyText: "On its way." } })).toBe(1)
      const audits = await db.auditLog.findMany({ where: { entityId: id, action: "WEBSITE_CHAT_STAFF_REPLY" } })
      expect(audits.map((a) => a.userEmail)).toEqual(["thandi@test.invalid"])
    }
  })

  describe("through the assignment route", () => {
    it("claim, release, then a colleague's claim leave joined, left, joined in the transcript", async () => {
      const id = await chat("route-order")
      expect(await route(id, thandi, { action: "claim" })).toEqual({ status: 200, body: { ok: true } })
      expect(await route(id, lwazi, { action: "release" })).toEqual({ status: 409, body: { ok: false, reason: "NOT_ASSIGNED_TO_YOU" } })
      expect(await route(id, thandi, { action: "release" })).toEqual({ status: 200, body: { ok: true } })
      expect(await route(id, lwazi, { action: "claim" })).toEqual({ status: 200, body: { ok: true } })

      const lines = await db.message.findMany({ where: { conversationId: id, createdById: { not: null } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
      expect(lines.map((m) => [m.createdById, m.bodyText])).toEqual([[thandi, JOINED], [thandi, LEFT], [lwazi, "Lwazi from Acme Lending has joined the chat."]])
      expect((await thread(id)).assigneeId).toBe(lwazi)
      expect(await actions(id)).toEqual(["WEBSITE_CHAT_STAFF_JOINED", "WEBSITE_CHAT_STAFF_LEFT", "WEBSITE_CHAT_STAFF_JOINED"])
      // What the visitor's window is given: each staff line keeps its own author's name after the handover.
      const shown = await loadChat(tenantId, id)
      expect(shown?.staffFirstName).toBe("Lwazi")
      expect(shown?.lines.map((l) => [l.from, l.name])).toEqual([["assistant", undefined], ["staff", "Thandi"], ["staff", "Thandi"], ["staff", "Lwazi"]])
    })

    it("release by a colleague is refused; by an admin it releases the chat in the colleague's name", async () => {
      const id = await chat("route-admin")
      expect(await route(id, thandi, { action: "claim" })).toEqual({ status: 200, body: { ok: true } })
      for (const role of ["CREDIT_OFFICER", "LOAN_ADMIN"]) {
        expect(await route(id, lwazi, { action: "release" }, role)).toEqual({ status: 409, body: { ok: false, reason: "NOT_ASSIGNED_TO_YOU" } })
      }
      expect((await thread(id)).assigneeId).toBe(thandi)
      expect(await route(id, lwazi, { action: "release" }, "ADMIN")).toEqual({ status: 200, body: { ok: true } })
      expect((await thread(id)).assigneeId).toBeNull()
      expect(await staffLines(id)).toEqual([JOINED, LEFT])
      const [left] = await db.auditLog.findMany({ where: { entityId: id, action: "WEBSITE_CHAT_STAFF_LEFT" } })
      expect(left).toMatchObject({ userId: lwazi, oldValue: { assigneeId: thandi } })
    })

    it("refuses to reassign a website chat, joined or not, and changes nothing", async () => {
      const refused = { status: 409, body: { error: "Website chats can't be reassigned. Release the chat and let a colleague join it." } }
      const id = await chat("route-reassign")
      expect(await route(id, thandi, { action: "reassign", assigneeId: lwazi })).toEqual(refused)
      expect(await thread(id)).toEqual({ assigneeId: null, lastOutboundAt: t0, lastActivityAt: t0 })
      expect(await staffLines(id)).toEqual([])

      await join(id)
      const before = await db.conversation.findUniqueOrThrow({ where: { id } })
      expect(await route(id, thandi, { action: "reassign", assigneeId: lwazi })).toEqual(refused)
      expect(await db.conversation.findUniqueOrThrow({ where: { id } })).toEqual(before)
      expect(await staffLines(id)).toEqual([JOINED])
      expect(await actions(id)).toEqual(["WEBSITE_CHAT_STAFF_JOINED"])
    })

    it("still reassigns a thread on another channel", async () => {
      const contact = await db.contact.create({ data: { tenantId, status: "LEAD", firstSeenChannel: "WHATSAPP", firstName: "wa3" } })
      const whatsApp = (await db.conversation.create({ data: { tenantId, contactId: contact.id, channel: "WHATSAPP", status: "OPEN" } })).id
      expect(await route(whatsApp, thandi, { action: "reassign", assigneeId: lwazi })).toEqual({ status: 200, body: { ok: true } })
      expect((await thread(whatsApp)).assigneeId).toBe(lwazi)
    })
  })
})
