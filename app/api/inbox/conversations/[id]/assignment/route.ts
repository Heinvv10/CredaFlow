import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { claimConversation, releaseConversation, reassignConversation } from "@/lib/inbox/assignment"
import { hasMinRole } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { joinChat, leaveChat } from "@/lib/website-chat/staff"

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id } = await ctx.params
  const body = (await req.json()) as { action?: string; assigneeId?: string }

  if (body.action === "reassign" && !body.assigneeId) {
    return NextResponse.json({ error: "assigneeId required for reassign" }, { status: 400 })
  }
  if (!["claim", "release", "reassign"].includes(body.action ?? "")) {
    return NextResponse.json({ error: "invalid action" }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    const common = { tenantId: tenant.id, conversationId: id }
    // A website chat is joined and left, not claimed and released: the visitor is told
    // in the same transaction, so a takeover is always in the stored transcript.
    const cv = await prisma.conversation.findFirst({ where: { id, tenantId: tenant.id }, select: { channel: true } })
    const isChat = cv?.channel === "CHATBOT"
    if (isChat && body.action === "reassign") {
      return NextResponse.json({ error: "Website chats can't be reassigned. Release the chat and let a colleague join it." }, { status: 409 })
    }
    const staff = { ...common, staffUserId: guard.user.id, staffEmail: guard.user.email, now: new Date() }
    let result
    if (body.action === "claim") {
      result = isChat ? await joinChat(staff) : await claimConversation({ ...common, agentUserId: guard.user.id, agentEmail: guard.user.email })
    } else if (body.action === "release") {
      // An admin may release a chat a colleague holds and walked away from; the visitor is told that colleague left.
      result = isChat ? await leaveChat({ ...staff, asAdmin: hasMinRole(guard.user.role, "ADMIN") }) : await releaseConversation({ ...common, agentUserId: guard.user.id, agentEmail: guard.user.email })
    } else {
      result = await reassignConversation({ ...common, newAssigneeId: body.assigneeId!, actorUserId: guard.user.id, actorEmail: guard.user.email })
    }
    if (!result.ok) return NextResponse.json({ ok: false, reason: result.reason }, { status: 409 })
    return NextResponse.json({ ok: true })
  })
}
