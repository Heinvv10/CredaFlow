import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

export type AssignResult = { ok: true } | { ok: false; reason: "ALREADY_CLAIMED" | "NOT_ASSIGNED_TO_YOU" | "NOT_FOUND" }

export async function claimConversation(a: {
  tenantId: string; conversationId: string; agentUserId: string; agentEmail?: string
}): Promise<AssignResult> {
  const res = await prisma.conversation.updateMany({
    where: { id: a.conversationId, tenantId: a.tenantId, assigneeId: null, status: { not: "CLOSED" } },
    data: { assigneeId: a.agentUserId },
  })
  if (res.count === 0) return { ok: false, reason: "ALREADY_CLAIMED" }
  await logAudit({
    tenantId: a.tenantId, userId: a.agentUserId, userEmail: a.agentEmail,
    action: "CONVERSATION_CLAIMED", entity: "Conversation", entityId: a.conversationId,
    newValue: { assigneeId: a.agentUserId },
  })
  return { ok: true }
}

export async function releaseConversation(a: {
  tenantId: string; conversationId: string; agentUserId: string; agentEmail?: string
}): Promise<AssignResult> {
  const res = await prisma.conversation.updateMany({
    where: { id: a.conversationId, tenantId: a.tenantId, assigneeId: a.agentUserId },
    data: { assigneeId: null },
  })
  if (res.count === 0) return { ok: false, reason: "NOT_ASSIGNED_TO_YOU" }
  await logAudit({
    tenantId: a.tenantId, userId: a.agentUserId, userEmail: a.agentEmail,
    action: "CONVERSATION_RELEASED", entity: "Conversation", entityId: a.conversationId,
    oldValue: { assigneeId: a.agentUserId }, newValue: { assigneeId: null },
  })
  return { ok: true }
}

export async function reassignConversation(a: {
  tenantId: string; conversationId: string; newAssigneeId: string; actorUserId: string; actorEmail?: string
}): Promise<AssignResult> {
  const current = await prisma.conversation.findFirst({
    where: { id: a.conversationId, tenantId: a.tenantId },
    select: { assigneeId: true },
  })
  if (!current) return { ok: false, reason: "NOT_FOUND" }
  await prisma.conversation.updateMany({
    where: { id: a.conversationId, tenantId: a.tenantId },
    data: { assigneeId: a.newAssigneeId },
  })
  await logAudit({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "CONVERSATION_REASSIGNED", entity: "Conversation", entityId: a.conversationId,
    oldValue: { assigneeId: current.assigneeId }, newValue: { assigneeId: a.newAssigneeId },
  })
  return { ok: true }
}
