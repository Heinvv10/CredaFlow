/**
 * Real-DB proof of Conversation.lastActivityAt.
 *
 * The unit suites mock Prisma, and a mocked Prisma cannot execute an ORDER BY,
 * cannot run the migration's backfill UPDATE, and cannot tell you whether an
 * index exists. Everything in this file needs a real Postgres:
 *
 *   RUN_LAST_ACTIVITY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/inbox/conversation-last-activity.integration.test.ts
 *
 * against a database that has had `prisma migrate deploy` run on it.
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { listConversations } from "./conversations"
import { getContactComms } from "./contact-comms"

const suite = process.env.RUN_LAST_ACTIVITY_IT === "1" ? describe : describe.skip
const prisma = new PrismaClient()

suite("Conversation.lastActivityAt", () => {
  const tag = randomUUID().replaceAll("-", "").slice(0, 12)
  let tenantId = ""
  let contactId = ""

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `IT ${tag}`, slug: `it-${tag}` } })
    tenantId = tenant.id
    // firstSeenChannel is NOT NULL with no default — omitting it fails at insert.
    const contact = await prisma.contact.create({
      data: { tenantId, firstName: "IT", lastName: tag, firstSeenChannel: "WHATSAPP" },
    })
    contactId = contact.id
  })

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { tenantId } })
    await prisma.conversation.deleteMany({ where: { tenantId } })
    await prisma.contact.deleteMany({ where: { tenantId } })
    // getContactComms upserts a CommsSettings row for the tenant — it holds an
    // FK to Tenant, so the tenant delete below fails without this.
    await prisma.commsSettings.deleteMany({ where: { tenantId } })
    await prisma.tenant.deleteMany({ where: { id: tenantId } })
    await prisma.$disconnect()
  })

  // Conversation_one_open_per_contact allows one thread per contact with
  // closedAt NULL. Threads that must both be open (the queue hides CLOSED)
  // therefore need a contact each.
  async function freshContact(): Promise<string> {
    const c = await prisma.contact.create({
      data: { tenantId, firstName: "IT", lastName: `${tag}-${randomUUID().slice(0, 8)}`, firstSeenChannel: "WHATSAPP" },
    })
    return c.id
  }

  // THE DEFECT. Ordered by lastInboundAt NULLS LAST, the outbound-only thread
  // sat below the stale one; with 30-row paging that is invisibility, not a
  // cosmetic reshuffle. This runs the real listConversations query against a
  // real Postgres, so it is the ORDER BY itself under test, not a query shape.
  it("sorts a recent outbound-only conversation ABOVE an older one with inbound", async () => {
    const recentOutbound = new Date("2026-08-19T08:00:00.000Z")
    const staleInbound = new Date("2025-01-01T00:00:00.000Z")

    const outboundOnly = await prisma.conversation.create({
      data: {
        tenantId, contactId, channel: "WHATSAPP", status: "OPEN",
        lastInboundAt: null,
        lastOutboundAt: recentOutbound,
        lastActivityAt: recentOutbound,
      },
    })
    const oldInbound = await prisma.conversation.create({
      data: {
        tenantId, contactId: await freshContact(), channel: "WHATSAPP", status: "OPEN",
        lastInboundAt: staleInbound,
        lastOutboundAt: null,
        lastActivityAt: staleInbound,
      },
    })

    const { conversations } = await listConversations({
      tenantId, queue: "all", agentUserId: "nobody",
    })
    const ids = conversations.map((c) => c.id)
    expect(ids.indexOf(outboundOnly.id)).toBeLessThan(ids.indexOf(oldInbound.id))
    expect(ids[0]).toBe(outboundOnly.id)
  })

  // The badge is a claim about inbound the agent has not opened. Sorting the
  // outbound-only thread to the top must not make it look like it is owed a
  // read — proved against real rows, not a groupBy mock.
  it("keeps the unread badge counting only INBOUND, unaffected by the new sort key", async () => {
    const now = new Date("2026-08-20T10:00:00.000Z")
    const cv = await prisma.conversation.create({
      data: {
        tenantId, contactId: await freshContact(), channel: "WHATSAPP", status: "OPEN",
        lastOutboundAt: now, lastActivityAt: now,
      },
    })
    // Two unread OUTBOUND + one unread INBOUND. Only the inbound may count.
    await prisma.message.createMany({
      data: [
        { tenantId, conversationId: cv.id, channel: "WHATSAPP", direction: "OUTBOUND", provider: "MANUAL", readAt: null },
        { tenantId, conversationId: cv.id, channel: "WHATSAPP", direction: "OUTBOUND", provider: "MANUAL", readAt: null },
        { tenantId, conversationId: cv.id, channel: "WHATSAPP", direction: "INBOUND", provider: "MANUAL", readAt: null },
        { tenantId, conversationId: cv.id, channel: "WHATSAPP", direction: "INBOUND", provider: "MANUAL", readAt: now },
      ],
    })

    const { conversations } = await listConversations({ tenantId, queue: "all", agentUserId: "nobody" })
    const row = conversations.find((c) => c.id === cv.id)!
    expect(row.unreadCount).toBe(1)
  })

  // The client record's Comms tab (components/comms/ClientCommsTab.tsx) renders
  // getContactComms().conversations in array order and auto-selects
  // conversations[0]. Ordered by lastInboundAt, a thread we only ever SENT on
  // sank to the bottom of the client's own history — the one thread staff open
  // this tab to find, ranked last, and never the default selection. Nothing was
  // hidden (no `take` on this query), but the order was wrong on the surface
  // that exists to prove what we sent.
  it("sorts an outbound-only thread above an older inbound one in a contact's thread list", async () => {
    const listContact = await prisma.contact.create({
      data: { tenantId, firstName: "Comms", lastName: tag, firstSeenChannel: "EMAIL" },
    })
    const recentOutbound = new Date("2026-08-19T08:00:00.000Z")
    const staleInbound = new Date("2025-01-01T00:00:00.000Z")

    const outboundOnly = await prisma.conversation.create({
      data: {
        tenantId, contactId: listContact.id, channel: "EMAIL", status: "OPEN",
        subject: "Section 129 notice sent",
        lastInboundAt: null, lastOutboundAt: recentOutbound, lastActivityAt: recentOutbound,
      },
    })
    const oldInbound = await prisma.conversation.create({
      data: {
        // One open thread per contact: the older thread is closed history,
        // which getContactComms lists alongside the open one.
        tenantId, contactId: listContact.id, channel: "EMAIL", status: "CLOSED", closedAt: staleInbound,
        subject: "Old query",
        lastInboundAt: staleInbound, lastOutboundAt: null, lastActivityAt: staleInbound,
      },
    })

    const { conversations } = await getContactComms({ tenantId, contactId: listContact.id })
    const ids = conversations.map((c) => c.id)
    expect(ids.indexOf(outboundOnly.id)).toBeLessThan(ids.indexOf(oldInbound.id))
    // conversations[0] is what ClientCommsTab opens by default.
    expect(ids[0]).toBe(outboundOnly.id)
  })

  // Backfill semantics, executed by Postgres rather than restated in JS.
  // GREATEST ignores NULL arguments, and COALESCE(..., createdAt) covers the
  // both-null case so no row is left unrankable.
  it("backfills lastActivityAt as the later of the two timestamps, falling back to createdAt", async () => {
    const earlier = new Date("2026-03-01T00:00:00.000Z")
    const later = new Date("2026-06-01T00:00:00.000Z")
    // Five threads on one contact: all closed, so the one-open-per-contact
    // index does not apply. The backfill expression ignores status.
    const closed = { status: "CLOSED" as const, closedAt: later }

    const bothInboundNewer = await prisma.conversation.create({
      data: { tenantId, contactId, channel: "EMAIL", ...closed, lastInboundAt: later, lastOutboundAt: earlier },
    })
    const bothOutboundNewer = await prisma.conversation.create({
      data: { tenantId, contactId, channel: "EMAIL", ...closed, lastInboundAt: earlier, lastOutboundAt: later },
    })
    const inboundOnly = await prisma.conversation.create({
      data: { tenantId, contactId, channel: "EMAIL", ...closed, lastInboundAt: later, lastOutboundAt: null },
    })
    const outboundOnly = await prisma.conversation.create({
      data: { tenantId, contactId, channel: "EMAIL", ...closed, lastInboundAt: null, lastOutboundAt: later },
    })
    const neither = await prisma.conversation.create({
      data: { tenantId, contactId, channel: "EMAIL", ...closed, lastInboundAt: null, lastOutboundAt: null },
    })

    const ids = [bothInboundNewer.id, bothOutboundNewer.id, inboundOnly.id, outboundOnly.id, neither.id]
    // Clear the values the creates wrote, then re-run the migration's exact
    // backfill expression over these rows.
    await prisma.$executeRawUnsafe(
      `UPDATE "Conversation" SET "lastActivityAt" = NULL WHERE "id" = ANY($1::text[])`,
      ids,
    )
    await prisma.$executeRawUnsafe(
      `UPDATE "Conversation"
         SET "lastActivityAt" = COALESCE(GREATEST("lastInboundAt", "lastOutboundAt"), "createdAt")
       WHERE "id" = ANY($1::text[])`,
      ids,
    )

    const rows = await prisma.conversation.findMany({
      where: { id: { in: ids } },
      select: { id: true, lastActivityAt: true, createdAt: true },
    })
    const byId = new Map(rows.map((r) => [r.id, r]))

    expect(byId.get(bothInboundNewer.id)!.lastActivityAt).toEqual(later)
    expect(byId.get(bothOutboundNewer.id)!.lastActivityAt).toEqual(later)
    expect(byId.get(inboundOnly.id)!.lastActivityAt).toEqual(later)
    // The row the old ordering made invisible: no inbound, but it now ranks.
    expect(byId.get(outboundOnly.id)!.lastActivityAt).toEqual(later)
    // Both null: falls back to createdAt rather than staying unrankable.
    const n = byId.get(neither.id)!
    expect(n.lastActivityAt).toEqual(n.createdAt)
    expect(rows.every((r) => r.lastActivityAt !== null)).toBe(true)
  })

  // The column is only worth having if the queue's ORDER BY can use an index;
  // that is the whole reason it exists instead of an inline GREATEST().
  it("has the indexes the queue ordering needs", async () => {
    const idx = await prisma.$queryRawUnsafe<{ indexname: string }[]>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'Conversation' AND indexdef LIKE '%lastActivityAt%'`,
    )
    const names = idx.map((r) => r.indexname)
    expect(names).toContain("Conversation_tenantId_assigneeId_status_lastActivityAt_idx")
    expect(names).toContain("Conversation_tenantId_channel_status_lastActivityAt_idx")
  })

  // The migration must stay applicable ahead of the app image. A trigger, a
  // CHECK, or a NOT NULL here would reject writes the currently-running
  // release still makes and force a downtime window.
  it("adds no enforcement to Conversation — the column stays nullable", async () => {
    const col = await prisma.$queryRawUnsafe<{ is_nullable: string }[]>(
      `SELECT is_nullable FROM information_schema.columns
        WHERE table_name = 'Conversation' AND column_name = 'lastActivityAt'`,
    )
    expect(col[0]?.is_nullable).toBe("YES")

    const enforcing = await prisma.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*)::bigint AS n FROM pg_indexes
        WHERE tablename = 'Conversation' AND indexdef LIKE '%lastActivityAt%'
          AND indexdef LIKE '%UNIQUE%'`,
    )
    expect(Number(enforcing[0].n)).toBe(0)
  })
})
