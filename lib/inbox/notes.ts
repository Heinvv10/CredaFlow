import { prisma } from "@/lib/prisma"
import { logAudit, AuditAction } from "@/lib/audit"
import { Prisma } from "@prisma/client"

/**
 * The mention id list comes from the browser, so it is caller-controlled.
 * Filtering it against ACTIVE users in THIS tenant is the boundary that stops
 * a caller tagging — and, via the fan-out, mailing — a user in another tenant
 * a note about a borrower they have no relationship with. It is the only thing
 * standing there: User is deliberately NOT in TENANT_SCOPED_MODELS
 * (lib/tenant-scope.ts), so nothing injects a tenant filter behind this query.
 * All three where-clauses are load-bearing; dropping `active` mails a
 * deactivated account. The author is dropped from the result: nobody needs a
 * bell for their own note.
 */
async function resolveMentions(a: {
  tenantId: string
  authorUserId: string
  mentionUserIds?: string[]
}): Promise<string[]> {
  const requested = [...new Set(a.mentionUserIds ?? [])].filter((id) => id !== a.authorUserId)
  if (requested.length === 0) return []
  const valid = await prisma.user.findMany({
    where: { tenantId: a.tenantId, active: true, id: { in: requested } },
    select: { id: true },
  })
  const allowed = new Set(valid.map((u) => u.id))
  return requested.filter((id) => allowed.has(id))
}

/**
 * Internal notes are Message rows (direction INTERNAL_NOTE, isInternal true)
 * that are never dispatched. They live here rather than in thread-actions.ts
 * because they have their own lifecycle — add, edit, retract, mention.
 *
 * newMentionUserIds is the resolved, tenant-checked list the caller should
 * notify. It is returned rather than serialised to the browser — who was
 * notified is not something a caller should be able to enumerate by POSTing
 * ids.
 */
export async function addInternalNote(a: {
  tenantId: string
  conversationId: string
  authorUserId: string
  authorEmail?: string
  text: string
  mentionUserIds?: string[]
}): Promise<{ id: string; newMentionUserIds: string[] } | null> {
  const cv = await prisma.conversation.findFirst({
    where: { id: a.conversationId, tenantId: a.tenantId },
    select: { channel: true },
  })
  if (!cv) return null

  const mentionUserIds = await resolveMentions({
    tenantId: a.tenantId,
    authorUserId: a.authorUserId,
    mentionUserIds: a.mentionUserIds,
  })

  const note = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        tenantId: a.tenantId,
        conversationId: a.conversationId,
        channel: cv.channel,
        direction: "INTERNAL_NOTE",
        provider: "MANUAL",
        isInternal: true,
        bodyText: a.text,
        createdById: a.authorUserId,
      },
      select: { id: true },
    })
    if (mentionUserIds.length > 0) {
      // Inside the transaction: a note whose mention rows failed to write
      // would leave the tagged staffer with a bell pointing at nothing.
      await tx.messageMention.createMany({
        data: mentionUserIds.map((userId) => ({ tenantId: a.tenantId, messageId: created.id, userId })),
        skipDuplicates: true,
      })
    }
    // getInboxDeltas selects on Conversation.updatedAt. Creating a Message
    // does not touch the parent row, so without this write the note is
    // invisible to every other agent's open inbox until they reselect the
    // thread. The value is irrelevant — @updatedAt overwrites it; writing
    // the row is what matters.
    await tx.conversation.update({
      where: { id: a.conversationId },
      data: { updatedAt: new Date() },
    })
    return created
  })

  await logAudit({
    tenantId: a.tenantId,
    userId: a.authorUserId,
    userEmail: a.authorEmail,
    action: AuditAction.COMMS_NOTE_ADDED,
    entity: "Message",
    entityId: note.id,
    newValue: { conversationId: a.conversationId, text: a.text },
  })

  return { id: note.id, newMentionUserIds: mentionUserIds }
}

export type NoteMutationResult =
  | { ok: true; id: string }
  | { ok: false; reason: "NOT_FOUND" | "NOT_A_NOTE" | "NOT_AUTHOR" | "ALREADY_DELETED" }

// NOT_A_NOTE is 404, not 400: a caller poking message ids must not learn from
// the status code whether an id exists and is a real customer message.
export function noteFailureStatus(reason: Exclude<NoteMutationResult, { ok: true }>["reason"]): number {
  switch (reason) {
    case "NOT_AUTHOR": return 403
    case "ALREADY_DELETED": return 409
    default: return 404
  }
}

const NOTE_GUARD_SELECT = {
  id: true, conversationId: true, isInternal: true, direction: true,
  createdById: true, bodyText: true, deletedAt: true,
} as const

/**
 * Author-only, no time limit. The DB trigger owns the invariants no request can
 * be trusted with (a note cannot change author or thread); authorship is a
 * request-scoped question and lives here.
 *
 * conversationId is required, not optional: both route pairs carry a
 * conversationId in the URL, but the note is looked up here by id alone
 * unless the caller passes it through — that gap let a staffer's own note on
 * a DIFFERENT conversation resolve through this conversation's URL. Making
 * it a required parameter (not a post-hoc equality check on the loaded row)
 * means TypeScript enumerates every call site.
 */
type NoteGuardRow = {
  id: string; conversationId: string; isInternal: boolean; direction: string
  createdById: string | null; bodyText: string | null; deletedAt: Date | null
}

async function loadMutableNote(
  tenantId: string,
  conversationId: string,
  noteId: string,
  actorUserId: string,
): Promise<{ error?: undefined; row: NoteGuardRow } | { error: NoteMutationResult & { ok: false }; row?: undefined }> {
  const row = await prisma.message.findFirst({
    where: { id: noteId, tenantId, conversationId },
    select: NOTE_GUARD_SELECT,
  })
  if (!row) return { error: { ok: false, reason: "NOT_FOUND" } }
  if (!row.isInternal || row.direction !== "INTERNAL_NOTE") {
    return { error: { ok: false, reason: "NOT_A_NOTE" } }
  }
  if (row.deletedAt !== null) {
    return { error: { ok: false, reason: "ALREADY_DELETED" } }
  }
  if (row.createdById !== actorUserId) {
    return { error: { ok: false, reason: "NOT_AUTHOR" } }
  }
  return { row }
}

export async function editInternalNote(a: {
  tenantId: string; conversationId: string; noteId: string; actorUserId: string; actorEmail?: string; text: string
  mentionUserIds?: string[]
}): Promise<NoteMutationResult & { newMentionUserIds?: string[] }> {
  const loaded = await loadMutableNote(a.tenantId, a.conversationId, a.noteId, a.actorUserId)
  if (loaded.error) return loaded.error
  const previous = loaded.row.bodyText

  // Update + audit row are one transaction, unlike the repo's usual
  // write-then-logAudit convention: an edit overwrites bodyText in place, so
  // the audit row's oldValue is the ONLY surviving copy of the pre-edit
  // text. logAudit deliberately swallows failures to console.error
  // (lib/audit.ts) — if the update committed and the audit insert then
  // failed, the prior text would be gone with no record. tx.auditLog.create
  // is used directly so both writes commit or neither does.
  const written = await prisma.$transaction(async (tx) => {
    // updateMany + count check, not update(): a concurrent delete between
    // loadMutableNote's read and this write must surface as ALREADY_DELETED
    // rather than silently writing new text onto an already-deleted note
    // (harmless today only because redaction keys off deletedAt at read
    // time — this stops the write succeeding at all).
    const result = await tx.message.updateMany({
      where: { id: a.noteId, deletedAt: null },
      data: { bodyText: a.text, editedAt: new Date(), editedById: a.actorUserId },
    })
    if (result.count === 0) return false

    await tx.auditLog.create({
      data: {
        tenantId: a.tenantId,
        userId: a.actorUserId,
        userEmail: a.actorEmail ?? null,
        action: AuditAction.COMMS_NOTE_EDITED,
        entity: "Message",
        entityId: a.noteId,
        oldValue: (previous === null ? Prisma.JsonNull : { text: previous }) as Prisma.InputJsonValue,
        newValue: { text: a.text },
      },
    })
    return true
  })

  if (!written) return { ok: false, reason: "ALREADY_DELETED" }

  // Mentions are resolved AFTER the update: the edit is the state change worth
  // protecting, and a mention row that fails to write must not roll back the
  // corrected text. Mentions dropped from the text are left in place — the row
  // records that the person was tagged at the time, which is the question the
  // table answers.
  // Non-fatal, unlike the add path: the edit has committed and been audited,
  // so throwing here would report a change that LANDED as a 500 and send the
  // staffer back to retry it, producing a second audit row for one edit. The
  // delta is dropped rather than returned on failure — the rows are not there,
  // so notifying would point a bell at a note that does not list the person.
  let newMentionUserIds: string[] = []
  try {
    newMentionUserIds = await addNewMentions(a)
  } catch (error) {
    console.error("Failed to write note mention rows:", { noteId: a.noteId }, error)
  }
  return { ok: true, id: a.noteId, newMentionUserIds }
}

/**
 * Returns only the DELTA — mentions on this note that were not already
 * recorded. Re-notifying everyone on every typo fix trains people to ignore
 * the bell.
 */
async function addNewMentions(a: {
  tenantId: string; noteId: string; actorUserId: string; mentionUserIds?: string[]
}): Promise<string[]> {
  const requested = await resolveMentions({
    tenantId: a.tenantId,
    authorUserId: a.actorUserId,
    mentionUserIds: a.mentionUserIds,
  })
  if (requested.length === 0) return []

  const existing = await prisma.messageMention.findMany({
    where: { tenantId: a.tenantId, messageId: a.noteId },
    select: { userId: true },
  })
  const already = new Set(existing.map((m) => m.userId))
  const newMentionUserIds = requested.filter((id) => !already.has(id))
  if (newMentionUserIds.length > 0) {
    await prisma.messageMention.createMany({
      data: newMentionUserIds.map((userId) => ({ tenantId: a.tenantId, messageId: a.noteId, userId })),
      skipDuplicates: true,
    })
  }
  return newMentionUserIds
}

export async function softDeleteInternalNote(a: {
  tenantId: string; conversationId: string; noteId: string; actorUserId: string; actorEmail?: string
}): Promise<NoteMutationResult> {
  const loaded = await loadMutableNote(a.tenantId, a.conversationId, a.noteId, a.actorUserId)
  if (loaded.error) return loaded.error

  await prisma.message.update({
    where: { id: a.noteId },
    data: { deletedAt: new Date(), deletedById: a.actorUserId },
  })

  // The body stays on the row — soft delete hides it, it does not destroy it.
  // The audit row records who retracted it and what it said at that moment.
  // Unlike editInternalNote, this does NOT need the update+audit to be
  // atomic: bodyText is untouched by a delete, so if the audit insert below
  // fails, loaded.row.bodyText is still sitting on the row as the source of
  // truth — logAudit's fire-and-forget failure mode loses nothing here.
  await logAudit({
    tenantId: a.tenantId,
    userId: a.actorUserId,
    userEmail: a.actorEmail,
    action: AuditAction.COMMS_NOTE_DELETED,
    entity: "Message",
    entityId: a.noteId,
    oldValue: { text: loaded.row.bodyText },
  })
  return { ok: true, id: a.noteId }
}
