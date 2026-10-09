import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { editInternalNote, softDeleteInternalNote, noteFailureStatus } from "@/lib/inbox/notes"
import { notifyNoteMentions } from "@/lib/inbox/note-mentions"

// Ownership must be re-checked here, not inherited from the note id: authorship
// alone would let a staffer mutate their own note on a DIFFERENT client's
// thread through this client's URL.
async function assertOwned(tenantId: string, clientId: string, conversationId: string) {
  const client = await prisma.client.findFirst({
    where: { id: clientId, tenantId },
    include: { contact: true },
  })
  if (!client || !client.contact) {
    return NextResponse.json({ error: "client has no contact" }, { status: 400 })
  }
  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, tenantId, contactId: client.contact.id },
    select: { id: true },
  })
  if (!owned) return NextResponse.json({ error: "conversation not found" }, { status: 404 })
  return null
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; conversationId: string; noteId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: clientId, conversationId, noteId } = await ctx.params
  const body = (await req.json()) as { text?: string; mentionUserIds?: unknown }
  const text = (body.text ?? "").trim()
  if (text === "") return NextResponse.json({ error: "text is required" }, { status: 400 })
  // An edit can add a tag the original note did not have. Wire shape only —
  // see the sibling POST route; resolveMentions is the security boundary.
  const mentionUserIds = Array.isArray(body.mentionUserIds)
    ? body.mentionUserIds.filter((v): v is string => typeof v === "string")
    : undefined

  return withTenantContext(req, async (tenant) => {
    const denied = await assertOwned(tenant.id, clientId, conversationId)
    if (denied) return denied

    const res = await editInternalNote({
      tenantId: tenant.id, conversationId, noteId, actorUserId: guard.user.id, actorEmail: guard.user.email, text,
      mentionUserIds,
    })
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: noteFailureStatus(res.reason) })
    // Only the delta, and only on the success branch: newMentionUserIds is
    // readable on the failure branch of the intersection type too.
    if (res.newMentionUserIds && res.newMentionUserIds.length > 0) {
      await notifyNoteMentions({
        tenantId: tenant.id,
        noteId: res.id,
        conversationId,
        authorName: guard.user.name || guard.user.email,
        text,
        userIds: res.newMentionUserIds,
      })
    }
    return NextResponse.json({ ok: true, id: res.id })
  })
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; conversationId: string; noteId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: clientId, conversationId, noteId } = await ctx.params

  return withTenantContext(req, async (tenant) => {
    const denied = await assertOwned(tenant.id, clientId, conversationId)
    if (denied) return denied

    const res = await softDeleteInternalNote({
      tenantId: tenant.id, conversationId, noteId, actorUserId: guard.user.id, actorEmail: guard.user.email,
    })
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: noteFailureStatus(res.reason) })
    return NextResponse.json({ ok: true, id: res.id })
  })
}
