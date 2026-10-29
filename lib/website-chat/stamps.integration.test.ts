/**
 * Real-Postgres proof that a website chat's thread stamps (lastInboundAt,
 * lastOutboundAt, lastActivityAt) only ever move forward. Each request reads its
 * clock when it starts, so two of them can commit in the other order; a stamp that
 * moved back would release a chat early, or rank it below older traffic.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/website-chat/stamps.integration.test.ts
 */
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { stampThread } from "./rows"
import { joinChat, releaseIdleChats, sendStaffChatReply } from "./staff"
import { recordAssistantReply, recordVisitorMessage, recordVisitorMessageToStaff, startChat } from "./store"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("website chat thread stamps", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_web_stamps_${token}`
  const staff = `user_stamps_${token}`
  const t0 = new Date("2026-09-29T10:00:00Z")
  const at = (min: number, sec = 0) => new Date(t0.getTime() + min * 60_000 + sec * 1000)
  const stamps = (id: string) => db.conversation.findUniqueOrThrow({ where: { id }, select: { lastInboundAt: true, lastOutboundAt: true, lastActivityAt: true } })
  const chat = async () => (await startChat({ brand: "Acme Lending", tenantId, fields: { firstName: "Sipho", lastName: "Dlamini", phone: "27825550007", email: `${randomUUID()}@test.invalid` }, now: t0 })).conversationId
  async function held() {
    const id = await chat()
    expect(await joinChat({ tenantId, conversationId: id, staffUserId: staff, now: at(1) })).toEqual({ ok: true })
    return id
  }

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `web-stamps-${token}`, name: "Website chat stamps IT", domain: null, config: { create: VALID_LENDER_COLUMNS } } })
    await db.user.create({ data: { id: staff, tenantId, email: `${staff}@test.invalid`, password: "x", name: "Thandi Mokoena" } })
  })

  afterAll(async () => {
    const where = { tenantId }
    await purgeAuditRowsForTest(db, where)
    await db.message.deleteMany({ where })
    await db.conversation.deleteMany({ where })
    await db.contactConsent.deleteMany({ where })
    await db.contact.deleteMany({ where })
    await db.crmActivity.deleteMany({ where })
    await db.lead.deleteMany({ where })
    await db.user.deleteMany({ where })
    await db.tenantConfig.deleteMany({ where: { tenantId: tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("two visitor messages committed out of order leave the later stamp, so the abandoned-chat release counts from it", async () => {
    const id = await held()
    await recordVisitorMessageToStaff({ tenantId, conversationId: id, text: "second, committed first", now: at(5) })
    await recordVisitorMessageToStaff({ tenantId, conversationId: id, text: "first, committed second", now: at(2) })
    expect(await stamps(id)).toMatchObject({ lastInboundAt: at(5), lastActivityAt: at(5) })
    // Ten minutes from the earlier stamp would release it at 12; the visitor last wrote at 5.
    expect(await releaseIdleChats(tenantId, at(12))).toBe(0)
    expect(await releaseIdleChats(tenantId, at(15))).toBe(1)
  })

  it("a staff reply stamped before the visitor's message but committed after it leaves the activity stamp where it was", async () => {
    const id = await held()
    await recordVisitorMessageToStaff({ tenantId, conversationId: id, text: "What is my balance?", now: at(2, 10) })
    expect((await sendStaffChatReply({ tenantId, conversationId: id, staffUserId: staff, text: "Checking.", now: at(2) })).ok).toBe(true)
    // lastOutboundAt is the database trigger's: the latest sentAt among the thread's sent messages.
    expect(await stamps(id)).toEqual({ lastInboundAt: at(2, 10), lastOutboundAt: at(2), lastActivityAt: at(2, 10) })
  })

  it("on the assistant's path too: a late-committing question or reply never moves a stamp back", async () => {
    const id = await chat()
    expect(await recordVisitorMessage({ tenantId, conversationId: id, text: "later", now: at(4) })).toEqual({ accepted: true })
    expect(await recordVisitorMessage({ tenantId, conversationId: id, text: "earlier", now: at(3) })).toEqual({ accepted: true })
    expect(await recordAssistantReply({ tenantId, conversationId: id, reply: "An answer.", needsHuman: false, reason: null, now: at(3, 30) })).toMatchObject({ suppressed: false })
    expect(await stamps(id)).toEqual({ lastInboundAt: at(4), lastOutboundAt: at(3, 30), lastActivityAt: at(4) })
  })

  it("stamps the instant given, whatever time zone the database session is in", async () => {
    const id = await chat()
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Africa/Johannesburg'")
      await stampThread(tx, { tenantId, conversationId: id, direction: "inbound", at: at(7) })
    })
    expect(await stamps(id)).toMatchObject({ lastInboundAt: at(7), lastActivityAt: at(7) })
  })

  it("never stamps another tenant's thread", async () => {
    const id = await chat()
    await prisma.$transaction((tx) => stampThread(tx, { tenantId: `other_${token}`, conversationId: id, direction: "inbound", at: at(9) }))
    expect(await stamps(id)).toEqual({ lastInboundAt: null, lastOutboundAt: t0, lastActivityAt: t0 })
  })
})
