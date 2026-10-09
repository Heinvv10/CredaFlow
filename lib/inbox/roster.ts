import { prisma } from "@/lib/prisma"
import { logAudit } from "@/lib/audit"

export type RosterMember = {
  id: string
  name: string | null
  email: string
  role: string
  isCommsAgent: boolean
}

const ROSTER_SELECT = { id: true, name: true, email: true, role: true, isCommsAgent: true } as const

// No role filter needed to exclude portal accounts: `User.role` is the
// Prisma `UserRole` enum, which has no CLIENT member — portal client
// sessions come from the separate `Client` table (see lib/auth.ts,
// lib/auth-config.ts `AppRole = UserRole | "CLIENT"`). A User row can
// never carry role "CLIENT"; filtering for it would throw at the DB
// (invalid enum value), not silently no-op.
export function listStaffForRoster(tenantId: string): Promise<RosterMember[]> {
  return prisma.user.findMany({
    where: { tenantId, active: true },
    select: ROSTER_SELECT,
    orderBy: { name: "asc" },
  }) as Promise<RosterMember[]>
}

export function listActiveCommsAgents(tenantId: string): Promise<RosterMember[]> {
  return prisma.user.findMany({
    where: { tenantId, active: true, isCommsAgent: true },
    select: ROSTER_SELECT,
    orderBy: { name: "asc" },
  }) as Promise<RosterMember[]>
}

export async function setCommsAgent(a: {
  tenantId: string; userId: string; isCommsAgent: boolean; actorUserId: string; actorEmail?: string
}): Promise<{ ok: boolean }> {
  const res = await prisma.user.updateMany({
    where: { id: a.userId, tenantId: a.tenantId },
    data: { isCommsAgent: a.isCommsAgent },
  })
  if (res.count === 0) return { ok: false }
  await logAudit({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "USER_UPDATED", entity: "User", entityId: a.userId,
    newValue: { isCommsAgent: a.isCommsAgent },
  })
  return { ok: true }
}
