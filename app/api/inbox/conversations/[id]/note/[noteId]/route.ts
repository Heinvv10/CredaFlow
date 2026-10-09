import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { editInternalNote, softDeleteInternalNote, noteFailureStatus } from "@/lib/inbox/notes"
import { notifyNoteMentions } from "@/lib/inbox/note-mentions"

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id: conversationId, noteId } = await ctx.params
  const body = (await req.json()) as { text?: string; mentionUserIds?: unknown }
  const text = (body.text ?? "").trim()
  if (text === "") return NextResponse.json({ error: "text is required" }, { status: 400 })
  // An edit can add a tag the original note did not have. Wire shape only —
  // see the sibling POST route; resolveMentions is the security boundary.
  const mentionUserIds = Array.isArray(body.mentionUserIds)
    ? body.mentionUserIds.filter((v): v is string => typeof v === "string")
    : undefined

  return withTenantContext(req, async (tenant) => {
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

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string; noteId: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id: conversationId, noteId } = await ctx.params

  return withTenantContext(req, async (tenant) => {
    const res = await softDeleteInternalNote({
      tenantId: tenant.id, conversationId, noteId, actorUserId: guard.user.id, actorEmail: guard.user.email,
    })
    if (!res.ok) return NextResponse.json({ error: res.reason }, { status: noteFailureStatus(res.reason) })
    return NextResponse.json({ ok: true, id: res.id })
  })
}
