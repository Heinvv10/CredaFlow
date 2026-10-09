import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { addInternalNote } from "@/lib/inbox/notes"
import { notifyNoteMentions } from "@/lib/inbox/note-mentions"

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id } = await ctx.params
  const body = (await req.json()) as { text?: string; mentionUserIds?: unknown }
  const text = (body.text ?? "").trim()
  if (text === "") return NextResponse.json({ error: "text is required" }, { status: 400 })
  // Wire shape only — a JSON body can carry anything, and a non-string member
  // would reach Prisma as `{ in: [null] }`. The security check is in
  // resolveMentions: this list is still caller-controlled after coercion.
  const mentionUserIds = Array.isArray(body.mentionUserIds)
    ? body.mentionUserIds.filter((v): v is string => typeof v === "string")
    : undefined

  return withTenantContext(req, async (tenant) => {
    const note = await addInternalNote({ tenantId: tenant.id, conversationId: id, authorUserId: guard.user.id, authorEmail: guard.user.email, text, mentionUserIds })
    if (note === null) return NextResponse.json({ error: "Not found" }, { status: 404 })
    // After the note is committed, never inside its transaction. The null
    // check above IS the success branch — notifyNoteMentions never throws.
    if (note.newMentionUserIds.length > 0) {
      await notifyNoteMentions({
        tenantId: tenant.id,
        noteId: note.id,
        conversationId: id,
        // `||`, not `??`: a staffer who cleared their name would otherwise
        // send a subject line beginning with a blank.
        authorName: guard.user.name || guard.user.email,
        text,
        userIds: note.newMentionUserIds,
      })
    }
    // Only { id } goes back. newMentionUserIds is a server-side concern for the
    // notification fan-out — the composer already knows who it tagged, and a
    // caller must not be able to enumerate who got notified by POSTing ids.
    return NextResponse.json({ id: note.id })
  })
}
