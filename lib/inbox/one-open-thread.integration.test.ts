/**
 * Real-DB proof that the partial unique index actually blocks a second open
 * thread. Green unit tests cannot see this — the invariant lives in the DB.
 *
 *   RUN_INBOX_ONE_OPEN_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/inbox/one-open-thread.integration.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { randomUUID } from "node:crypto"
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { resolveOpenThreadForContact } from "./resolve-thread"
import { setConversationStatus } from "./thread-actions"

const FIXTURE = randomUUID().replaceAll("-", "")
const TENANT_ID = `test-tenant-one-open-${FIXTURE}`
const CONTACT_ID = `test-contact-one-open-${FIXTURE}`

const RUN = process.env.RUN_INBOX_ONE_OPEN_IT === "1"
const suite = RUN ? describe : describe.skip

suite("Conversation_one_open_per_contact", () => {
  beforeAll(() => withoutTenantScope(async () => {
    await prisma.tenant.upsert({
      where: { id: TENANT_ID },
      update: {},
      create: { id: TENANT_ID, slug: TENANT_ID, name: "one-open-per-contact test" },
    })
    await prisma.contact.upsert({
      where: { id: CONTACT_ID },
      update: {},
      create: {
        id: CONTACT_ID, tenantId: TENANT_ID, status: "CLIENT",
        firstSeenChannel: "MANUAL", firstSeenContext: "integration-test",
      },
    })
  }))

  afterAll(() => withoutTenantScope(async () => {
    await prisma.message.deleteMany({ where: { tenantId: TENANT_ID } })
    await prisma.conversation.deleteMany({ where: { tenantId: TENANT_ID } })
    await prisma.contact.deleteMany({ where: { id: CONTACT_ID } })
    await prisma.tenant.deleteMany({ where: { id: TENANT_ID } })
  }))

  it("rejects a second open conversation for the same contact with P2002", () => withoutTenantScope(async () => {
    await prisma.conversation.create({
      data: { tenantId: TENANT_ID, contactId: CONTACT_ID, channel: "WHATSAPP", status: "OPEN" },
    })

    const second = prisma.conversation.create({
      data: { tenantId: TENANT_ID, contactId: CONTACT_ID, channel: "EMAIL", status: "OPEN" },
    })

    await expect(second).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    )
  }))

  it("allows a new open conversation once the previous one is closed", () => withoutTenantScope(async () => {
    const open = await prisma.conversation.findFirstOrThrow({
      where: { tenantId: TENANT_ID, contactId: CONTACT_ID, closedAt: null },
    })
    await prisma.conversation.update({
      where: { id: open.id },
      data: { closedAt: new Date(), status: "CLOSED" },
    })

    const reopened = await prisma.conversation.create({
      data: { tenantId: TENANT_ID, contactId: CONTACT_ID, channel: "EMAIL", status: "OPEN" },
    })
    expect(reopened.id).not.toBe(open.id)
  }))

  it("setConversationStatus refuses to reopen a closed thread whose contact has an open sibling", () => withoutTenantScope(async () => {
    // The DB, not a mock, is what makes this a real proof: the pre-check and
    // the P2002 map to the SAME typed refusal, and the route must never see a
    // throw. Leaves the fixture with exactly one open thread, as it found it.
    const open = await prisma.conversation.findFirstOrThrow({
      where: { tenantId: TENANT_ID, contactId: CONTACT_ID, closedAt: null },
    })
    const closed = await prisma.conversation.create({
      data: {
        tenantId: TENANT_ID, contactId: CONTACT_ID, channel: "WHATSAPP",
        status: "CLOSED", closedAt: new Date("2026-08-01T00:00:00.000Z"),
      },
    })

    const result = await setConversationStatus({
      tenantId: TENANT_ID, conversationId: closed.id, status: "OPEN", actorUserId: "it-actor",
    })

    expect(result).toEqual({ ok: false, reason: "ANOTHER_THREAD_OPEN", openConversationId: open.id })
    const stillClosed = await prisma.conversation.findUniqueOrThrow({ where: { id: closed.id } })
    expect(stillClosed.closedAt).not.toBeNull()
    expect(stillClosed.status).toBe("CLOSED")
  }))

  it("resolveOpenThreadForContact returns the one open thread across channels", () => withoutTenantScope(async () => {
    const first = await prisma.$transaction((tx) =>
      resolveOpenThreadForContact(tx, {
        tenantId: TENANT_ID, contactId: CONTACT_ID, channel: "WHATSAPP", now: new Date(),
      }),
    )
    const second = await prisma.$transaction((tx) =>
      resolveOpenThreadForContact(tx, {
        tenantId: TENANT_ID, contactId: CONTACT_ID, channel: "EMAIL", now: new Date(),
      }),
    )
    expect(second.id).toBe(first.id)
    expect(second.created).toBe(false)
  }))
})
