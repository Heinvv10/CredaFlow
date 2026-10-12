import { prisma } from "@/lib/prisma"
import { logAuditStrict } from "@/lib/audit"

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

// Pass the transaction as `db` to write the flag and its audit row in it; the
// audit write is strict so neither commits without the other.
export async function setCommsAgent(a: {
  tenantId: string; userId: string; isCommsAgent: boolean; actorUserId: string; actorEmail?: string
}, db: Pick<typeof prisma, "user" | "auditLog"> = prisma): Promise<{ ok: boolean }> {
  const res = await db.user.updateMany({
    where: { id: a.userId, tenantId: a.tenantId },
    data: { isCommsAgent: a.isCommsAgent },
  })
  if (res.count === 0) return { ok: false }
  await logAuditStrict({
    tenantId: a.tenantId, userId: a.actorUserId, userEmail: a.actorEmail,
    action: "USER_UPDATED", entity: "User", entityId: a.userId,
    newValue: { isCommsAgent: a.isCommsAgent },
  }, db)
  return { ok: true }
}
