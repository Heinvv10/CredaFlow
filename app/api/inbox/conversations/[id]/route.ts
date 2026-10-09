import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { getThread } from "@/lib/inbox/conversations"
import { markConversationRead, setConversationStatus, setConversationPriority } from "@/lib/inbox/thread-actions"

const STATUSES = ["OPEN", "CLOSED", "PENDING_CUSTOMER", "PENDING_INTERNAL"] as const
const PRIORITIES = ["NORMAL", "HIGH", "URGENT"] as const
type Status = (typeof STATUSES)[number]
type Priority = (typeof PRIORITIES)[number]

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id } = await ctx.params
  return withTenantContext(req, async (tenant) => {
    await markConversationRead({ tenantId: tenant.id, conversationId: id })
    const thread = await getThread({ tenantId: tenant.id, conversationId: id })
    if (!thread) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json(thread)
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id } = await ctx.params
  const body = (await req.json()) as { status?: string; priority?: string }

  if (body.status !== undefined && !STATUSES.includes(body.status as Status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 })
  }
  if (body.priority !== undefined && !PRIORITIES.includes(body.priority as Priority)) {
    return NextResponse.json({ error: "invalid priority" }, { status: 400 })
  }
  if (body.status === undefined && body.priority === undefined) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    if (body.status !== undefined) {
      const result = await setConversationStatus({ tenantId: tenant.id, conversationId: id, status: body.status as Status, actorUserId: guard.user.id, actorEmail: guard.user.email })
      if (!result.ok && result.reason === "ANOTHER_THREAD_OPEN") {
        // One open thread per contact (Conversation_one_open_per_contact).
        // Reopening this one would make a second — send the agent to the thread
        // that already holds the slot rather than 500ing on the raw P2002.
        return NextResponse.json(
          { error: "This contact already has an open thread — open that one instead.", openConversationId: result.openConversationId },
          { status: 409 },
        )
      }
      if (!result.ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (body.priority !== undefined) {
      const result = await setConversationPriority({ tenantId: tenant.id, conversationId: id, priority: body.priority as Priority, actorUserId: guard.user.id, actorEmail: guard.user.email })
      if (!result.ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    return NextResponse.json({ ok: true })
  })
}
