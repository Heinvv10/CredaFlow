import type { UserRole } from "@prisma/client"
import type { Tx } from "@/lib/maker-checker/types"
import type { prisma } from "@/lib/prisma"

export const SYSTEM_USER_NAME = "Automated decisioning"
/** Not a bcrypt hash, so no password ever matches; the CHECK User_system_no_login holds the rest. */
export const SYSTEM_USER_PASSWORD = "!"

export interface SystemUser {
  id: string
  email: string
  /** As stored: the database holds it at LOAN_ADMIN (CHECK User_system_no_login), but the decision path is told what the row says. */
  role: UserRole
}

/**
 * The per-lender actor automatic approvals and declines are booked under. It is
 * a User row because the lending tables reference approvers by user id, but it
 * cannot sign in or be made to: inactive, no usable password, and the database
 * refuses to change either (CHECK User_system_no_login, one per lender). It
 * decides screening nothing and holds no session, so it can never collide with
 * the screening or segregation-of-duties rules a human delegate would.
 * Provisioned when engine settings are first approved (the change handler).
 */
export async function ensureSystemUser(tx: Pick<Tx, "user">, tenantId: string): Promise<SystemUser> {
  const existing = await tx.user.findFirst({ where: { tenantId, isSystem: true }, select: { id: true, email: true, role: true } })
  if (existing) return existing
  const created = await tx.user.create({
    data: {
      tenantId,
      email: `automated-decisioning+${tenantId}@system.invalid`,
      name: SYSTEM_USER_NAME,
      password: SYSTEM_USER_PASSWORD,
      role: "LOAN_ADMIN",
      active: false,
      isSystem: true,
    },
    select: { id: true, email: true, role: true },
  })
  return created
}

export async function findSystemUser(db: Pick<typeof prisma, "user">, tenantId: string): Promise<SystemUser | null> {
  return db.user.findFirst({ where: { tenantId, isSystem: true }, select: { id: true, email: true, role: true } })
}
