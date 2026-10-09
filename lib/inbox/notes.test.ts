/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"

const tx = {
  message: { create: vi.fn(), updateMany: vi.fn() },
  conversation: { update: vi.fn() },
  auditLog: { create: vi.fn() },
  // No findMany here: the edit path reads existing mentions OUTSIDE the
  // transaction, so a tx stub for it would read as load-bearing when nothing
  // calls it.
  messageMention: { createMany: vi.fn() },
}

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: { findFirst: vi.fn() },
    message: { findFirst: vi.fn(), update: vi.fn() },
    user: { findMany: vi.fn() },
    messageMention: { createMany: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn((cb: any) => cb(tx)),
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn(),
  AuditAction: {
    COMMS_NOTE_ADDED: "COMMS_NOTE_ADDED",
    COMMS_NOTE_EDITED: "COMMS_NOTE_EDITED",
    COMMS_NOTE_DELETED: "COMMS_NOTE_DELETED",
  },
}))

import { addInternalNote, editInternalNote, softDeleteInternalNote, noteFailureStatus } from "./notes"
import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

beforeEach(() => {
  vi.clearAllMocks()
  tx.message.create.mockResolvedValue({ id: "n1" })
  tx.conversation.update.mockResolvedValue({ id: "cv1" })
  tx.message.updateMany.mockResolvedValue({ count: 1 })
  tx.auditLog.create.mockResolvedValue({ id: "a1" })
  tx.messageMention.createMany.mockResolvedValue({ count: 0 })
  vi.mocked(prisma.user.findMany).mockResolvedValue([] as any)
  vi.mocked(prisma.messageMention.findMany).mockResolvedValue([] as any)
  vi.mocked(prisma.messageMention.createMany).mockResolvedValue({ count: 0 } as any)
})

it("returns null and writes nothing when the conversation is not in this tenant", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
  const r = await addInternalNote({ tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "careful" })
  expect(r).toBeNull()
  expect(prisma.$transaction).not.toHaveBeenCalled()
  expect(logAudit).not.toHaveBeenCalled()
})

// Ordering, not just the outcome: the tenant check has to run BEFORE the
// mention ids are resolved, or a caller could probe user ids against a
// conversation they have no access to.
it("does not resolve mention ids when the conversation is not in this tenant", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue(null as any)
  await addInternalNote({
    tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "@Bo look",
    mentionUserIds: ["u2"],
  })
  expect(prisma.user.findMany).not.toHaveBeenCalled()
})

it("creates the note on the conversation's channel", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ channel: "WHATSAPP" } as any)
  const r = await addInternalNote({ tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "careful" })
  expect(r).toEqual({ id: "n1", newMentionUserIds: [] })
  expect(tx.message.create).toHaveBeenCalledWith({
    data: {
      tenantId: "t1",
      conversationId: "cv1",
      channel: "WHATSAPP",
      direction: "INTERNAL_NOTE",
      provider: "MANUAL",
      isInternal: true,
      bodyText: "careful",
      createdById: "u1",
    },
    select: { id: true },
  })
})

// The delta endpoint filters on Conversation.updatedAt. Without this bump a
// note never reaches another agent's open inbox.
it("bumps the parent conversation so the note reaches the delta poll", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ channel: "EMAIL" } as any)
  await addInternalNote({ tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "careful" })
  expect(tx.conversation.update).toHaveBeenCalledWith({
    where: { id: "cv1" },
    data: { updatedAt: expect.any(Date) },
  })
})

it("audits the note", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ channel: "EMAIL" } as any)
  await addInternalNote({ tenantId: "t1", conversationId: "cv1", authorUserId: "u1", authorEmail: "a@b.c", text: "careful" })
  expect(logAudit).toHaveBeenCalledWith({
    tenantId: "t1",
    userId: "u1",
    userEmail: "a@b.c",
    action: "COMMS_NOTE_ADDED",
    entity: "Message",
    entityId: "n1",
    newValue: { conversationId: "cv1", text: "careful" },
  })
})

const noteRow = {
  id: "n1", conversationId: "cv1", isInternal: true, direction: "INTERNAL_NOTE",
  createdById: "u1", bodyText: "original", deletedAt: null,
}

it("edit rejects a message that is not a note", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue({ ...noteRow, isInternal: false, direction: "OUTBOUND" } as any)
  const r = await editInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "x" })
  expect(r).toEqual({ ok: false, reason: "NOT_A_NOTE" })
  expect(tx.message.updateMany).not.toHaveBeenCalled()
})

it("edit rejects a non-author", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  const r = await editInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u2", text: "x" })
  expect(r).toEqual({ ok: false, reason: "NOT_AUTHOR" })
  expect(tx.message.updateMany).not.toHaveBeenCalled()
})

it("edit rejects a deleted note", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue({ ...noteRow, deletedAt: new Date() } as any)
  const r = await editInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "x" })
  expect(r).toEqual({ ok: false, reason: "ALREADY_DELETED" })
})

// The note is looked up scoped to conversationId, not just id + tenantId — a
// note authored on a DIFFERENT conversation must not resolve here, even if
// the actor authored it. This is the disjoint-guard fix: without conversationId
// in the where-clause, a staffer's own note on Client B's thread could be
// edited through Client A's URL.
it("scopes the lookup to the given conversation", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  await editInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "x" })
  expect(vi.mocked(prisma.message.findFirst).mock.calls[0][0]).toMatchObject({
    where: { id: "n1", tenantId: "t1", conversationId: "cv1" },
  })
})

it("edit stamps the editor and audits the previous text atomically", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  const r = await editInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", actorEmail: "a@b.c", text: "corrected" })
  expect(r).toEqual({ ok: true, id: "n1", newMentionUserIds: [] })
  expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  const call = vi.mocked(tx.message.updateMany).mock.calls[0][0] as any
  expect(call.where).toEqual({ id: "n1", deletedAt: null })
  expect(call.data.bodyText).toBe("corrected")
  expect(call.data.editedById).toBe("u1")
  expect(call.data.editedAt).toBeInstanceOf(Date)
  // The update and the audit row must be written by the SAME transaction
  // client (tx), not the top-level logAudit helper — logAudit swallows
  // failures, and for an edit the audit row is the only surviving copy of
  // the pre-edit text.
  expect(tx.auditLog.create).toHaveBeenCalledWith({
    data: expect.objectContaining({
      tenantId: "t1",
      userId: "u1",
      userEmail: "a@b.c",
      action: "COMMS_NOTE_EDITED",
      entity: "Message",
      entityId: "n1",
      oldValue: { text: "original" },
      newValue: { text: "corrected" },
    }),
  })
  expect(logAudit).not.toHaveBeenCalled()
})

// Concurrent delete between loadMutableNote's read and the update: the
// where-clause includes deletedAt: null, so the race surfaces as
// ALREADY_DELETED instead of silently writing text onto a deleted note.
it("edit returns ALREADY_DELETED when the note is deleted between the read and the write", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  tx.message.updateMany.mockResolvedValue({ count: 0 })
  const r = await editInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "x" })
  expect(r).toEqual({ ok: false, reason: "ALREADY_DELETED" })
  expect(tx.auditLog.create).not.toHaveBeenCalled()
})

it("delete rejects a second delete", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue({ ...noteRow, deletedAt: new Date() } as any)
  const r = await softDeleteInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1" })
  expect(r).toEqual({ ok: false, reason: "ALREADY_DELETED" })
  expect(prisma.message.update).not.toHaveBeenCalled()
})

it("delete scopes the lookup to the given conversation", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  vi.mocked(prisma.message.update).mockResolvedValue({ id: "n1" } as any)
  await softDeleteInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1" })
  expect(vi.mocked(prisma.message.findFirst).mock.calls[0][0]).toMatchObject({
    where: { id: "n1", tenantId: "t1", conversationId: "cv1" },
  })
})

it("delete preserves the text in the audit trail", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  vi.mocked(prisma.message.update).mockResolvedValue({ id: "n1" } as any)
  const r = await softDeleteInternalNote({ tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", actorEmail: "a@b.c" })
  expect(r).toEqual({ ok: true, id: "n1" })
  expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
    action: "COMMS_NOTE_DELETED",
    oldValue: { text: "original" },
  }))
})

// The mention id list arrives from the browser. Filtering it against active
// users in THIS tenant is the whole boundary — User is deliberately not in
// TENANT_SCOPED_MODELS (lib/tenant-scope.ts), so nothing injects a tenant
// filter behind this query. All three where-clauses are asserted exactly.
it("drops mention ids that are not active users in this tenant", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ channel: "EMAIL" } as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u2" }] as any)
  const r = await addInternalNote({
    tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "@Bo look",
    mentionUserIds: ["u2", "u-other-tenant"],
  })
  expect(r).toEqual({ id: "n1", newMentionUserIds: ["u2"] })
  expect(vi.mocked(prisma.user.findMany).mock.calls[0][0]).toEqual({
    where: { tenantId: "t1", active: true, id: { in: ["u2", "u-other-tenant"] } },
    select: { id: true },
  })
  expect(tx.messageMention.createMany).toHaveBeenCalledWith({
    data: [{ tenantId: "t1", messageId: "n1", userId: "u2" }],
    skipDuplicates: true,
  })
})

// The assertion above pins the query shape; this one pins the OUTCOME against
// a mock that actually honours the where-clause, so dropping tenantId, active,
// or the id filter fails on the returned list rather than only on a shape
// mismatch. Task 11 emails everyone in that list.
it("resolves mentions against the tenant and active filters, not just the id list", async () => {
  const users = [
    { id: "u2", tenantId: "t1", active: true },
    { id: "u-inactive", tenantId: "t1", active: false },
    { id: "u-other-tenant", tenantId: "t2", active: true },
  ]
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ channel: "EMAIL" } as any)
  vi.mocked(prisma.user.findMany).mockImplementation((async (args: any) => {
    const w = args.where ?? {}
    return users
      .filter((u) => (w.tenantId === undefined || u.tenantId === w.tenantId))
      .filter((u) => (w.active === undefined || u.active === w.active))
      .filter((u) => (w.id?.in === undefined || w.id.in.includes(u.id)))
      .map((u) => ({ id: u.id }))
  }) as any)
  const r = await addInternalNote({
    tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "@all",
    mentionUserIds: ["u2", "u-inactive", "u-other-tenant"],
  })
  expect(r!.newMentionUserIds).toEqual(["u2"])
})

it("never notifies the author for mentioning themselves", async () => {
  vi.mocked(prisma.conversation.findFirst).mockResolvedValue({ channel: "EMAIL" } as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u1" }, { id: "u2" }] as any)
  const r = await addInternalNote({
    tenantId: "t1", conversationId: "cv1", authorUserId: "u1", text: "@me @Bo",
    mentionUserIds: ["u1", "u2"],
  })
  expect(r!.newMentionUserIds).toEqual(["u2"])
})

// Only the delta is returned. Re-notifying every existing mention on every
// typo fix trains people to ignore the bell.
it("edit re-notifies only newly added mentions", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  vi.mocked(prisma.messageMention.findMany).mockResolvedValue([{ userId: "u2" }] as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u2" }, { id: "u3" }] as any)
  const r = await editInternalNote({
    tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "@Bo @Cy",
    mentionUserIds: ["u2", "u3"],
  })
  expect(r).toEqual({ ok: true, id: "n1", newMentionUserIds: ["u3"] })
  expect(prisma.messageMention.createMany).toHaveBeenCalledWith({
    data: [{ tenantId: "t1", messageId: "n1", userId: "u3" }],
    skipDuplicates: true,
  })
})

// A mention removed from the text keeps its row: the table records that the
// person was tagged at the time, which is the question it answers.
it("edit leaves an existing mention row in place when the tag is removed", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  vi.mocked(prisma.messageMention.findMany).mockResolvedValue([{ userId: "u2" }] as any)
  const r = await editInternalNote({
    tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "no tags now",
    mentionUserIds: [],
  })
  expect(r).toEqual({ ok: true, id: "n1", newMentionUserIds: [] })
  expect(prisma.messageMention.createMany).not.toHaveBeenCalled()
})

// The edit has already committed and been audited by the time the mention
// rows are written. Reporting that as a failed edit would send the staffer
// back to retry a change that already landed, producing a second audit row.
it("edit still succeeds when the mention-row write rejects", async () => {
  vi.mocked(prisma.message.findFirst).mockResolvedValue(noteRow as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: "u2" }] as any)
  vi.mocked(prisma.messageMention.createMany).mockRejectedValue(new Error("db blip"))
  const r = await editInternalNote({
    tenantId: "t1", conversationId: "cv1", noteId: "n1", actorUserId: "u1", text: "@Bo",
    mentionUserIds: ["u2"],
  })
  expect(r).toEqual({ ok: true, id: "n1", newMentionUserIds: [] })
  expect(tx.message.updateMany).toHaveBeenCalled()
})

it("noteFailureStatus maps each reason to its status code", () => {
  // NOT_A_NOTE is 404, not 400: a caller poking message ids must not learn
  // from the status code whether an id exists and is a real customer message.
  expect(noteFailureStatus("NOT_FOUND")).toBe(404)
  expect(noteFailureStatus("NOT_A_NOTE")).toBe(404)
  expect(noteFailureStatus("NOT_AUTHOR")).toBe(403)
  expect(noteFailureStatus("ALREADY_DELETED")).toBe(409)
})
