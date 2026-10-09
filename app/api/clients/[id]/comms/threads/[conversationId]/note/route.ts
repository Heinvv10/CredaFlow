import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { addInternalNote } from "@/lib/inbox/notes"
import { notifyNoteMentions } from "@/lib/inbox/note-mentions"

// Any-staff (READONLY) internal note from the client Comms tab. Matches the
// sibling reply route's access model — that route already permits a READONLY
// staffer to send a real customer message, and a note is strictly smaller.
// Ownership is enforced below so a staffer can only annotate a conversation
// belonging to THIS client's contact. /inbox keeps its own requireCommsAgent
// route — this does not touch it.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; conversationId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: clientId, conversationId } = await ctx.params
  const body = (await req.json()) as { text?: string; mentionUserIds?: unknown }
  const text = (body.text ?? "").trim()
  if (text === "") return NextResponse.json({ error: "text is required" }, { status: 400 })
  // Wire shape only — see the sibling /inbox note route. resolveMentions is
  // what makes this list safe to notify.
  const mentionUserIds = Array.isArray(body.mentionUserIds)
    ? body.mentionUserIds.filter((v): v is string => typeof v === "string")
    : undefined

  return withTenantContext(req, async (tenant) => {
    const client = await prisma.client.findFirst({
      where: { id: clientId, tenantId: tenant.id },
      include: { contact: true },
    })
    if (!client || !client.contact) {
      return NextResponse.json({ error: "client has no contact" }, { status: 400 })
    }

    // Ownership: the conversation must belong to this client's contact.
    const owned = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: tenant.id, contactId: client.contact.id },
      select: { id: true },
    })
    if (!owned) return NextResponse.json({ error: "conversation not found" }, { status: 404 })

    const note = await addInternalNote({
      tenantId: tenant.id,
      conversationId,
      authorUserId: guard.user.id,
      authorEmail: guard.user.email,
      text,
      mentionUserIds,
    })
    if (note === null) return NextResponse.json({ error: "Not found" }, { status: 404 })
    // After the note is committed — see the sibling /inbox note route.
    if (note.newMentionUserIds.length > 0) {
      await notifyNoteMentions({
        tenantId: tenant.id,
        noteId: note.id,
        conversationId,
        authorName: guard.user.name || guard.user.email,
        text,
        userIds: note.newMentionUserIds,
      })
    }
    // Only { id } goes back — see the sibling /inbox note route.
    return NextResponse.json({ id: note.id })
  })
}
