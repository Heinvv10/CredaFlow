import { prisma } from "@/lib/prisma"
import type { CannedReply } from "@prisma/client"
import { logAudit } from "@/lib/audit"

export function listCannedReplies(tenantId: string): Promise<CannedReply[]> {
  return prisma.cannedReply.findMany({ where: { tenantId }, orderBy: { title: "asc" } })
}

export async function createCannedReply(a: {
  tenantId: string; title: string; body: string; createdById: string; actorEmail?: string
}): Promise<CannedReply> {
  const row = await prisma.cannedReply.create({
    data: { tenantId: a.tenantId, title: a.title, body: a.body, createdById: a.createdById },
  })
  await logAudit({
    tenantId: a.tenantId, userId: a.createdById, userEmail: a.actorEmail,
    action: "CANNED_REPLY_CREATED", entity: "CannedReply", entityId: row.id,
    newValue: { title: a.title },
  })
  return row
}

export async function updateCannedReply(a: {
  tenantId: string; id: string; title?: string; body?: string; actorUserId: string; actorEmail?: string
}): Promise<{ ok: boolean }> {
  const data: { title?: string; body?: string } = {}
  if (a.title !== undefined) data.title = a.title
  if (a.body !== undefined) data.body = a.body
  const res = await prisma.cannedReply.updateMany({ where: { id: a.id, tenantId: a.tenantId }, data })
  if (res.count === 0) return { ok: false }
  await logAudit({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "CANNED_REPLY_UPDATED", entity: "CannedReply", entityId: a.id, newValue: data,
  })
  return { ok: true }
}

export async function deleteCannedReply(a: {
  tenantId: string; id: string; actorUserId: string; actorEmail?: string
}): Promise<{ ok: boolean }> {
  const res = await prisma.cannedReply.deleteMany({ where: { id: a.id, tenantId: a.tenantId } })
  if (res.count === 0) return { ok: false }
  await logAudit({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "CANNED_REPLY_DELETED", entity: "CannedReply", entityId: a.id,
  })
  return { ok: true }
}
