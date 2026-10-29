/**
 * Real-Postgres proof of the abandoned-takeover exit: a chat whose visitor has been
 * waiting on the staff member holding it for 10 minutes is handed back to the
 * assistant by the minute sweep, exactly as if that person had left.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/staff-auto-release.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"

vi.mock("./alert", async (orig) => ({ ...(await orig<object>()), sendChatAlertEmail: vi.fn() }))

import { sweepHandoffs } from "./handoff-sweep"
import { joinChat, sendStaffChatReply, STAFF_IDLE_RELEASE_MS } from "./staff"
import { loadChat, recordAssistantReply, recordVisitorMessageToStaff, startChat } from "./store"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("sweepHandoffs: abandoned takeovers", () => {
  const db = new PrismaClient()
  const tenants: string[] = []
  const t0 = new Date("2026-09-29T10:00:00Z")
  const at = (min: number, sec = 0) => new Date(t0.getTime() + min * 60_000 + sec * 1000)
  const LEFT = "Thandi from Acme Lending has left the chat."

  /** The sweep reads every chat of a tenant, so each test gets a tenant, and a staff member, of its own. */
  async function tenant() {
    const id = `tenant_web_release${tenants.length}_${token}`
    await db.tenant.create({ data: { id, slug: id.replaceAll("_", "-"), name: "Website chat release IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    tenants.push(id)
    const staff = await db.user.create({ data: { tenantId: id, id: `user_${randomUUID()}`, email: `${randomUUID()}@test.invalid`, password: "x", name: "Thandi Mokoena" } })
    return { t: id, staff: staff.id }
  }
  /** A chat `staff` joined at +1 min. */
  async function joined(t: string, staff: string) {
    const id = (await startChat({ brand: "Acme Lending", tenantId: t, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550005", email: `${randomUUID()}@test.invalid` }, now: t0 })).conversationId
    expect(await joinChat({ tenantId: t, conversationId: id, staffUserId: staff, now: at(1) })).toEqual({ ok: true })
    return id
  }
  const visitorWrites = (t: string, id: string, now: Date) => recordVisitorMessageToStaff({ tenantId: t, conversationId: id, text: "Are you there?", now })
  const released = async (t: string, now: Date) => (await sweepHandoffs(t, now)).released
  const thread = (id: string) => db.conversation.findUniqueOrThrow({ where: { id }, select: { assigneeId: true, status: true } })
  const left = (id: string) => db.message.findMany({ where: { conversationId: id, bodyText: LEFT } })

  afterAll(async () => {
    const where = { tenantId: { in: tenants } }
    await purgeAuditRowsForTest(db, where)
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

  it("waits ten minutes", () => {
    expect(STAFF_IDLE_RELEASE_MS).toBe(10 * 60 * 1000)
  })

  it("a visitor left waiting on staff is released at 10 minutes, not at 9: told, audited, and back with the assistant", async () => {
    const { t, staff } = await tenant()
    const id = await joined(t, staff)
    await visitorWrites(t, id, at(2))

    expect(await released(t, at(11))).toBe(0)
    expect(await released(t, at(11, 59))).toBe(0)
    expect(await thread(id)).toEqual({ assigneeId: staff, status: "OPEN" })

    expect(await sweepHandoffs(t, at(12))).toEqual({ expired: 0, emailed: 0, failed: 0, released: 1 })
    expect(await thread(id)).toEqual({ assigneeId: null, status: "OPEN" })
    expect((await loadChat(t, id))?.mode).toBe("bot")
    // The same line a leave writes, in the name of the person who held the chat.
    const lines = await left(id)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({ tenantId: t, channel: "CHATBOT", direction: "OUTBOUND", provider: "MANUAL", createdById: staff, sentAt: at(12), isInternal: false })
    const log = await db.auditLog.findMany({ where: { entityId: id, action: "WEBSITE_CHAT_STAFF_AUTO_RELEASED" } })
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ tenantId: t, userId: null, entity: "Conversation", oldValue: { assigneeId: staff }, newValue: { assigneeId: null } })

    // Released once: nothing more on a later run.
    expect(await released(t, at(30))).toBe(0)
    expect(await left(id)).toHaveLength(1)
  })

  it("is not released when staff answered last, when the visitor never wrote, or when it is closed", async () => {
    const { t, staff } = await tenant()
    const answered = await joined(t, staff)
    await visitorWrites(t, answered, at(2))
    expect((await sendStaffChatReply({ tenantId: t, conversationId: answered, staffUserId: staff, text: "Yes, I'm here.", now: at(3) })).ok).toBe(true)
    const silent = await joined(t, staff)
    const closed = await joined(t, staff)
    await visitorWrites(t, closed, at(2))
    await db.conversation.update({ where: { id: closed }, data: { status: "CLOSED", closedAt: at(3) } })

    expect(await released(t, at(24 * 60))).toBe(0)
    for (const id of [answered, silent, closed]) {
      expect((await thread(id)).assigneeId).toBe(staff)
      expect(await left(id)).toEqual([])
    }
    expect(await db.auditLog.count({ where: { tenantId: t, action: "WEBSITE_CHAT_STAFF_AUTO_RELEASED" } })).toBe(0)
  })

  it("a deactivated staff member's chat is released once the visitor has written and waited", async () => {
    const { t, staff } = await tenant()
    const id = await joined(t, staff)
    await db.user.update({ where: { id: staff }, data: { active: false } })
    // Nobody is waiting yet.
    expect(await released(t, at(3 * 24 * 60))).toBe(0)
    expect((await thread(id)).assigneeId).toBe(staff)

    const wrote = at(3 * 24 * 60 + 1)
    await visitorWrites(t, id, wrote)
    expect(await released(t, new Date(wrote.getTime() + STAFF_IDLE_RELEASE_MS - 1000))).toBe(0)
    expect(await released(t, new Date(wrote.getTime() + STAFF_IDLE_RELEASE_MS))).toBe(1)
    expect(await thread(id)).toEqual({ assigneeId: null, status: "OPEN" })
    expect(await left(id)).toHaveLength(1)
  })

  it("a chat its holder set pending by hand is released to OPEN, so the next hand-off flips and opens a wait", async () => {
    const { t, staff } = await tenant()
    const id = await joined(t, staff)
    await db.conversation.update({ where: { id }, data: { status: "PENDING_INTERNAL" } })
    await visitorWrites(t, id, at(2))
    expect(await released(t, at(12))).toBe(1)
    expect(await thread(id)).toEqual({ assigneeId: null, status: "OPEN" })
    expect(await recordAssistantReply({ tenantId: t, conversationId: id, reply: "Passing you on.", needsHuman: true, reason: "complaint", now: at(13) }))
      .toMatchObject({ handedOffNow: true })
  })

  it("leaves other tenants' chats alone", async () => {
    const mine = await tenant()
    const other = await tenant()
    const theirs = await joined(other.t, other.staff)
    await visitorWrites(other.t, theirs, at(2))
    expect(await released(mine.t, at(60))).toBe(0)
    expect((await thread(theirs)).assigneeId).toBe(other.staff)
    expect(await left(theirs)).toEqual([])
  })

  it("a staff reply that lands while the sweep holds the chat in its batch keeps the chat with staff", async () => {
    const { t, staff } = await tenant()
    const id = await joined(t, staff)
    await visitorWrites(t, id, at(2))
    let sweep: Promise<number> | undefined
    try {
      // What a staff reply writes, held uncommitted with the thread row locked: the release must wait, then look again.
      // (The row and the stamp both: a database trigger recomputes lastOutboundAt from the accepted outbound messages.)
      await db.$transaction(async (tx) => {
        await tx.message.create({ data: { tenantId: t, conversationId: id, channel: "CHATBOT", provider: "MANUAL", direction: "OUTBOUND", status: "DELIVERED", createdById: staff, sentAt: at(11), bodyText: "Yes, I'm here." } })
        await tx.conversation.update({ where: { id }, data: { lastOutboundAt: at(11), lastActivityAt: at(11) } })
        sweep = released(t, at(12))
        await new Promise((done) => setTimeout(done, 300))
      }, { timeout: 10_000 })
    } finally {
      await Promise.allSettled([sweep])
    }
    expect(await sweep).toBe(0)
    expect((await thread(id)).assigneeId).toBe(staff)
    expect(await left(id)).toEqual([])
  })

  it("releases at most 100 chats a run, longest-waiting first; the next run takes the rest", async () => {
    const { t, staff } = await tenant()
    // One open thread per contact (unique index), so each chat gets a contact of its own.
    await db.contact.createMany({ data: Array.from({ length: 101 }, (_, i) => ({ id: `contact_rel_${i}_${token}`, tenantId: t, status: "LEAD" as const, firstSeenChannel: "CHATBOT" as const })) })
    await db.conversation.createMany({ data: Array.from({ length: 101 }, (_, i) => ({
      id: `conv_rel_${String(i).padStart(3, "0")}_${token}`, tenantId: t, contactId: `contact_rel_${i}_${token}`, channel: "CHATBOT" as const, status: "OPEN" as const,
      assigneeId: staff, lastOutboundAt: at(1), lastInboundAt: at(2, 100 - i), lastActivityAt: at(2, 100 - i),
    })) })
    // The last one created has waited longest; the first one created is the newest and is left for the next run.
    expect(await released(t, at(30))).toBe(100)
    expect(await db.conversation.findMany({ where: { tenantId: t, assigneeId: { not: null } }, select: { id: true } })).toEqual([{ id: `conv_rel_000_${token}` }])
    expect(await released(t, at(31))).toBe(1)
    expect(await db.conversation.count({ where: { tenantId: t, assigneeId: { not: null } } })).toBe(0)
  }, 60_000)
})
