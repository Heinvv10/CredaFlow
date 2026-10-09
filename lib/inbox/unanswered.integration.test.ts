/**
 * Real-Postgres proof of the unanswered badge for website chats. The unit suite
 * mocks Prisma and can only read the SQL text; this runs the predicate.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/inbox/unanswered.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { countUnansweredConversations } from "./unanswered"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const token = randomUUID().replaceAll("-", "")

suite("countUnansweredConversations on real rows", () => {
  const db = new PrismaClient()
  const tenantId = `tenant_unanswered_${token}`
  const staff = `user_unanswered_${token}`
  const t = (min: number) => new Date(Date.UTC(2026, 8, 29, 10, min))

  /** One thread per contact: an open thread is unique per contact. */
  async function thread(data: { channel?: "CHATBOT" | "WHATSAPP"; status?: "OPEN" | "PENDING_INTERNAL" | "CLOSED"; assigneeId?: string; lastInboundAt?: Date; lastOutboundAt?: Date }) {
    const contact = await db.contact.create({ data: { tenantId, status: "LEAD", firstSeenChannel: data.channel ?? "CHATBOT" } })
    const closedAt = data.status === "CLOSED" ? t(30) : null
    return db.conversation.create({ data: { tenantId, contactId: contact.id, channel: "CHATBOT", ...data, closedAt } })
  }

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `unanswered-${token}`, name: "Unanswered IT", domain: null } })
    await db.user.create({ data: { id: staff, tenantId, email: `${staff}@test.invalid`, password: "x" } })
  })

  afterAll(async () => {
    await db.conversation.deleteMany({ where: { tenantId } })
    await db.contact.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("counts a website chat whose visitor is waiting on the staffer holding it, and one handed off; not one the bot or staff answered last", async () => {
    const counted = [
      // Held by staff, the visitor wrote last.
      await thread({ assigneeId: staff, lastInboundAt: t(5), lastOutboundAt: t(4) }),
      // Held by staff, the visitor wrote and nobody has written back at all.
      await thread({ assigneeId: staff, lastInboundAt: t(5) }),
      // Handed off, as before.
      await thread({ status: "PENDING_INTERNAL", lastInboundAt: t(1), lastOutboundAt: t(2) }),
      // Any other channel: the customer spoke last.
      await thread({ channel: "WHATSAPP", lastInboundAt: t(5), lastOutboundAt: t(4) }),
    ]
    const notCounted = [
      // Held by staff, staff answered last, or at the same instant.
      await thread({ assigneeId: staff, lastInboundAt: t(4), lastOutboundAt: t(5) }),
      await thread({ assigneeId: staff, lastInboundAt: t(5), lastOutboundAt: t(5) }),
      // Held by staff, the visitor never wrote.
      await thread({ assigneeId: staff, lastOutboundAt: t(5) }),
      // Held, the visitor wrote last, but the chat is closed.
      await thread({ assigneeId: staff, status: "CLOSED", lastInboundAt: t(5), lastOutboundAt: t(4) }),
      // With the bot, the visitor wrote last: the bot always answers.
      await thread({ lastInboundAt: t(5), lastOutboundAt: t(4) }),
    ]
    expect(counted).toHaveLength(4)
    expect(notCounted).toHaveLength(5)
    expect(await countUnansweredConversations(tenantId)).toBe(4)
  })
})
