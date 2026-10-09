/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Real-DB proof of the MessageMention constraints, and of the
 * cross-conversation guard on note edit/delete.
 *
 *   RUN_MENTIONS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/inbox/mentions.integration.test.ts
 *
 * WHY THIS FILE EXISTS
 *   Every other test of @mentions mocks Prisma, and a mocked Prisma cannot
 *   execute a foreign key. Four properties the feature leans on were verified
 *   once by hand and pinned by nothing that runs:
 *     1. a mention row that cannot be written rolls the whole note back;
 *     2. onDelete: Restrict keeps "who was tagged" alive past a staff delete;
 *     3. the composite (tenantId, messageId) FK makes a cross-tenant mention
 *        row unwritable at the DB, behind resolveMentions' explicit filter;
 *     4. a note in conversation A cannot be edited or deleted through
 *        conversation B's id.
 *
 * Every DB-level refusal is asserted by Prisma error code AND by the name of
 * the constraint that fired. A test that accepts any error passes when the
 * fixture is broken or a column was renamed, which is how a green integration
 * suite ends up proving nothing.
 */
import { PrismaClient, Prisma } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { describe, expect, it, beforeAll, afterAll } from "vitest"
import { prisma as appPrisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { editInternalNote, softDeleteInternalNote } from "./notes"

const suite = process.env.RUN_MENTIONS_IT === "1" ? describe : describe.skip

// Raw client, deliberately NOT the @/lib/prisma singleton: properties 1-3 are
// claims about the DATABASE, so the tenant-scope extension must not be in the
// path to reject a write the database would have accepted anyway.
const db = new PrismaClient()

/**
 * Runs `op` expecting the database to refuse it, and hands back the Prisma
 * error so the caller can assert WHICH constraint fired. Throwing on success
 * (rather than expect(...).rejects) keeps the "it was accepted" failure
 * distinguishable from "it threw the wrong thing".
 */
async function refused(op: () => Promise<unknown>): Promise<Prisma.PrismaClientKnownRequestError> {
  try {
    await op()
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return error
    throw error
  }
  throw new Error("expected the database to refuse this write, but it succeeded")
}

/** P2003 is Prisma's wrapper for SQLSTATE 23503, foreign_key_violation. */
function expectForeignKey(error: Prisma.PrismaClientKnownRequestError, constraint: string): void {
  expect(error.code).toBe("P2003")
  expect(String((error.meta as any)?.field_name ?? "")).toContain(constraint)
}

suite("MessageMention DB constraints and the cross-conversation note guard", () => {
  const tag = randomUUID().replaceAll("-", "").slice(0, 12)
  let tenantId = ""
  let otherTenantId = ""
  let contactId = ""
  let conversationAId = ""
  let conversationBId = ""
  let authorId = ""
  let mentionedId = ""
  let otherTenantUserId = ""
  let noteId = ""

  beforeAll(async () => {
    const tenant = await db.tenant.create({ data: { name: `IT ${tag}`, slug: `it-${tag}` } })
    tenantId = tenant.id
    // The second tenant must really exist: MessageMention.tenantId carries TWO
    // foreign keys (tenant -> Tenant.id, and the composite (tenantId,
    // messageId) -> Message). With a fabricated tenant id the insert would be
    // refused by MessageMention_tenantId_fkey and property 3 would prove
    // nothing about the composite key.
    const otherTenant = await db.tenant.create({
      data: { name: `IT ${tag} other`, slug: `it-${tag}-other` },
    })
    otherTenantId = otherTenant.id

    // firstSeenChannel is NOT NULL with no default — omitting it fails at insert.
    const contact = await db.contact.create({
      data: { tenantId, firstName: "IT", lastName: tag, firstSeenChannel: "EMAIL" },
    })
    contactId = contact.id

    // Two conversations on ONE contact: the cross-conversation hijack this
    // guards against was a staffer reaching their own note through a
    // different thread's URL, which is a same-tenant attack.
    const cvA = await db.conversation.create({ data: { tenantId, contactId, channel: "EMAIL" } })
    conversationAId = cvA.id
    const cvB = await db.conversation.create({ data: { tenantId, contactId, channel: "SMS" } })
    conversationBId = cvB.id

    const author = await db.user.create({
      data: { email: `it-author-${tag}@example.test`, password: "not-a-real-hash", tenantId },
    })
    authorId = author.id
    const mentioned = await db.user.create({
      data: { email: `it-mentioned-${tag}@example.test`, password: "not-a-real-hash", tenantId },
    })
    mentionedId = mentioned.id
    // Belongs to the OTHER tenant, so the property-3 row is a plausible
    // cross-tenant mention rather than one with a dangling user.
    const otherTenantUser = await db.user.create({
      data: { email: `it-other-${tag}@example.test`, password: "not-a-real-hash", tenantId: otherTenantId },
    })
    otherTenantUserId = otherTenantUser.id

    // createdById is what editInternalNote/softDeleteInternalNote check for
    // authorship; without it every property-4 call returns NOT_AUTHOR and the
    // test would pass for the wrong reason.
    const note = await db.message.create({
      data: {
        tenantId, conversationId: conversationAId, channel: "EMAIL", direction: "INTERNAL_NOTE",
        provider: "MANUAL", isInternal: true, bodyText: "original", createdById: authorId,
      },
    })
    noteId = note.id
  })

  afterAll(async () => {
    // FK-safe order. Mentions first: MessageMention.userId is Restrict, so a
    // surviving mention row blocks the User delete below — the very property
    // this file proves. AuditLog before User for the same reason in spirit
    // (it is SetNull, but leaving rows behind poisons the next run's counts).
    await db.messageMention.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await db.message.deleteMany({ where: { tenantId } })
    await db.conversation.deleteMany({ where: { tenantId } })
    await db.contact.deleteMany({ where: { tenantId } })
    await db.auditLog.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await db.user.deleteMany({ where: { id: { in: [authorId, mentionedId, otherTenantUserId] } } })
    await db.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await db.$disconnect()
    await appPrisma.$disconnect()
  })

  // ── 1. The FK failure mode is a rollback, not a half-write ────────────────
  // resolveMentions validates the ids, then createMany writes them. A staffer
  // hard-deleted in that window makes the mention row unwritable. The note
  // must not survive alone: a note that claims a tag it never recorded shows
  // "@Thandi" in the thread while Thandi never gets a bell.
  it("rolls the note back when a mention row cannot be written", async () => {
    const bodyText = `rollback-${tag}`
    const ghostUserId = randomUUID() // the staffer, hard-deleted mid-flight

    const error = await refused(() =>
      // Same shape as addInternalNote: create + createMany in ONE transaction.
      db.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            tenantId, conversationId: conversationAId, channel: "EMAIL", direction: "INTERNAL_NOTE",
            provider: "MANUAL", isInternal: true, bodyText, createdById: authorId,
          },
          select: { id: true },
        })
        await tx.messageMention.createMany({
          data: [{ tenantId, messageId: created.id, userId: ghostUserId }],
          skipDuplicates: true,
        })
        await tx.conversation.update({
          where: { id: conversationAId },
          data: { updatedAt: new Date() },
        })
      }),
    )
    expectForeignKey(error, "MessageMention_userId_fkey")

    // The point of the test: the message.create is gone too.
    expect(await db.message.count({ where: { tenantId, bodyText } })).toBe(0)
  })

  // ── 2. onDelete: Restrict keeps "who was tagged" alive ────────────────────
  // Restrict rather than Cascade is deliberate: who was tagged is operator
  // identity and must survive a staff departure. If this ever became Cascade,
  // deleting a leaver would silently erase them from every note that named
  // them, and only this test would notice.
  it("refuses to delete a User who has mention rows, and keeps the row", async () => {
    await db.messageMention.createMany({
      data: [{ tenantId, messageId: noteId, userId: mentionedId }],
      skipDuplicates: true,
    })

    const error = await refused(() => db.user.delete({ where: { id: mentionedId } }))
    expectForeignKey(error, "MessageMention_userId_fkey")

    expect(await db.messageMention.count({ where: { messageId: noteId, userId: mentionedId } })).toBe(1)
    expect(await db.user.count({ where: { id: mentionedId } })).toBe(1)
  })

  // ── 3. The composite FK makes a cross-tenant mention row unwritable ───────
  // resolveMentions' explicit tenantId filter is the first line of defence;
  // this is the structural one behind it. Both tenants exist and both rows
  // exist, so the only thing that can refuse this insert is the composite
  // (tenantId, messageId) -> Message(tenantId, id) key.
  it("refuses a mention whose tenant does not own the message", async () => {
    const error = await refused(() =>
      db.messageMention.createMany({
        data: [{ tenantId: otherTenantId, messageId: noteId, userId: otherTenantUserId }],
        skipDuplicates: true,
      }),
    )
    expectForeignKey(error, "MessageMention_tenantId_messageId_fkey")

    expect(await db.messageMention.count({ where: { tenantId: otherTenantId } })).toBe(0)
  })

  // ── 4. Cross-conversation rejection, against a real DB ────────────────────
  // Both helpers are called inside runWithTenant because that is how they run
  // in production: the route handlers establish the tenant frame, and the
  // updateMany inside editInternalNote carries no tenantId of its own.
  it("refuses to edit or delete a note through another conversation's id", async () => {
    const viaB = await runWithTenant(tenantId, () =>
      editInternalNote({
        tenantId, conversationId: conversationBId, noteId,
        actorUserId: authorId, actorEmail: "it@example.test", text: "hijacked",
      }),
    )
    expect(viaB).toEqual({ ok: false, reason: "NOT_FOUND" })

    const deleteViaB = await runWithTenant(tenantId, () =>
      softDeleteInternalNote({
        tenantId, conversationId: conversationBId, noteId,
        actorUserId: authorId, actorEmail: "it@example.test",
      }),
    )
    expect(deleteViaB).toEqual({ ok: false, reason: "NOT_FOUND" })

    const after = await db.message.findUniqueOrThrow({
      where: { id: noteId },
      select: { bodyText: true, deletedAt: true, editedAt: true },
    })
    expect(after.bodyText).toBe("original")
    expect(after.deletedAt).toBeNull()
    expect(after.editedAt).toBeNull()
  })

  // Positive control for the test above. Without it, "NOT_FOUND through B"
  // would also be the result if the fixture had the wrong author, the wrong
  // tenant, or no note at all — the negative test would be green and vacuous.
  it("allows the same edit and delete through the note's own conversation", async () => {
    const edited = await runWithTenant(tenantId, () =>
      editInternalNote({
        tenantId, conversationId: conversationAId, noteId,
        actorUserId: authorId, actorEmail: "it@example.test", text: "corrected",
      }),
    )
    expect(edited.ok).toBe(true)
    expect((await db.message.findUniqueOrThrow({ where: { id: noteId } })).bodyText).toBe("corrected")

    const deleted = await runWithTenant(tenantId, () =>
      softDeleteInternalNote({
        tenantId, conversationId: conversationAId, noteId, actorUserId: authorId,
        actorEmail: "it@example.test",
      }),
    )
    expect(deleted).toEqual({ ok: true, id: noteId })
    expect((await db.message.findUniqueOrThrow({ where: { id: noteId } })).deletedAt).not.toBeNull()
  })
})
