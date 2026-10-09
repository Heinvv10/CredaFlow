/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Real-DB proof of Message_internal_note_mutability_guard.
 *
 *   RUN_NOTE_MUTABILITY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/inbox/note-mutability-migration.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { describe, expect, it, beforeAll, afterAll } from "vitest"

const suite = process.env.RUN_NOTE_MUTABILITY_IT === "1" ? describe : describe.skip
const prisma = new PrismaClient()

suite("Message internal-note mutability guard", () => {
  const tag = randomUUID().replaceAll("-", "").slice(0, 12)
  let tenantId = ""
  let otherTenantId = ""
  let contactId = ""
  let conversationId = ""
  let noteId = ""
  let outboundId = ""
  let userId = ""

  beforeAll(async () => {
    const tenant = await prisma.tenant.create({ data: { name: `IT ${tag}`, slug: `it-${tag}` } })
    tenantId = tenant.id
    // Second tenant is the move-target for the cross-tenant disjunct — it
    // only needs to exist as a valid FK, not carry any Message rows.
    const otherTenant = await prisma.tenant.create({ data: { name: `IT ${tag} other`, slug: `it-${tag}-other` } })
    otherTenantId = otherTenant.id
    // firstSeenChannel is NOT NULL with no default — omitting it fails at insert.
    const contact = await prisma.contact.create({
      data: { tenantId, firstName: "IT", lastName: tag, firstSeenChannel: "EMAIL" },
    })
    contactId = contact.id
    const cv = await prisma.conversation.create({
      data: { tenantId, contactId, channel: "EMAIL" },
    })
    conversationId = cv.id
    const note = await prisma.message.create({
      data: {
        tenantId, conversationId, channel: "EMAIL", direction: "INTERNAL_NOTE",
        provider: "MANUAL", isInternal: true, bodyText: "original",
      },
    })
    noteId = note.id
    const outbound = await prisma.message.create({
      data: {
        tenantId, conversationId, channel: "EMAIL", direction: "OUTBOUND",
        provider: "RESEND", isInternal: false, bodyText: "dear customer",
      },
    })
    outboundId = outbound.id
    // createdById is nullable and the note fixture leaves it NULL; the
    // createdById disjunct needs a real User row to reassign it to.
    const user = await prisma.user.create({
      data: { email: `it-${tag}@example.test`, password: "not-a-real-hash" },
    })
    userId = user.id
  })

  afterAll(async () => {
    await prisma.message.deleteMany({ where: { tenantId } })
    await prisma.conversation.deleteMany({ where: { tenantId } })
    await prisma.contact.deleteMany({ where: { tenantId } })
    await prisma.user.deleteMany({ where: { id: userId } })
    await prisma.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await prisma.$disconnect()
  })

  // If this one PASSES, the guard is not installed. It is the whole point of
  // the migration: customer message bodies become unrewritable at the DB.
  it("refuses to rewrite the body of a non-note message", async () => {
    await expect(
      prisma.message.update({ where: { id: outboundId }, data: { bodyText: "tampered" } }),
    ).rejects.toThrow(/not an internal note/)
  })

  it("refuses edit/delete markers on a non-note message", async () => {
    await expect(
      prisma.message.update({ where: { id: outboundId }, data: { deletedAt: new Date() } }),
    ).rejects.toThrow(/edit\/delete markers do not apply/)
  })

  it("allows a note body to be edited", async () => {
    const r = await prisma.message.update({
      where: { id: noteId },
      data: { bodyText: "corrected", editedAt: new Date() },
    })
    expect(r.bodyText).toBe("corrected")
  })

  // One assertion per disjunct in the note-branch IF — a guard tested only
  // by sample (e.g. conversationId + isInternal) can silently lose a
  // disjunct like `direction` with no test going red. See mutation proof
  // in the migration report: each of these five is independently killed.
  it("refuses to move a note to another thread or another author", async () => {
    const other = await prisma.conversation.create({ data: { tenantId, contactId, channel: "SMS" } })
    await expect(
      prisma.message.update({ where: { id: noteId }, data: { conversationId: other.id } }),
    ).rejects.toThrow(/cannot change author, thread or kind/)
    await expect(
      prisma.message.update({ where: { id: noteId }, data: { isInternal: false } }),
    ).rejects.toThrow(/cannot change author, thread or kind/)
    await expect(
      prisma.message.update({ where: { id: noteId }, data: { direction: "OUTBOUND" } }),
    ).rejects.toThrow(/cannot change author, thread or kind/)
    await expect(
      prisma.message.update({ where: { id: noteId }, data: { createdById: userId } }),
    ).rejects.toThrow(/cannot change author, thread or kind/)
    await expect(
      prisma.message.update({ where: { id: noteId }, data: { tenantId: otherTenantId } }),
    ).rejects.toThrow(/cannot change author, thread or kind/)
  })

  it("refuses to un-delete a note", async () => {
    await prisma.message.update({ where: { id: noteId }, data: { deletedAt: new Date() } })
    await expect(
      prisma.message.update({ where: { id: noteId }, data: { deletedAt: null } }),
    ).rejects.toThrow(/deletion is terminal/)
  })

  // The legacy placeholder guard is BEFORE INSERT OR UPDATE on the same table.
  // Two BEFORE triggers must coexist.
  it("still allows a note to be inserted", async () => {
    const extra = await prisma.message.create({
      data: {
        tenantId, conversationId, channel: "EMAIL", direction: "INTERNAL_NOTE",
        provider: "MANUAL", isInternal: true, bodyText: "second",
      },
    })
    expect(extra.id).toBeTruthy()
  })
})
