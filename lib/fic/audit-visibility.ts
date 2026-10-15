import type { Prisma } from "@prisma/client"
import { canAccessStrRegister } from "./str-cases"

/**
 * Tipping off: the general audit views (Settings → Audit log, GET /api/audit,
 * the audit-log report export) are open to LOAN_ADMIN, which is wider than the
 * STR register. A row about an STR case there tells a reader a report exists.
 * So every general AuditLog reader adds this filter: anyone without
 * manage_fic_compliance sees no SuspiciousReportCase row and no STR_* action.
 *
 * Returns the extra where clause to AND in, or null when nothing is hidden.
 */
export const STR_AUDIT_ENTITY = "SuspiciousReportCase"
export const STR_AUDIT_ACTION_PREFIX = "STR_"

export function strAuditExclusion(role: string): Prisma.AuditLogWhereInput | null {
  if (canAccessStrRegister(role)) return null
  return {
    NOT: [
      { entity: STR_AUDIT_ENTITY },
      { action: { startsWith: STR_AUDIT_ACTION_PREFIX } },
    ],
  }
}

/** `where` with the exclusion ANDed in for this viewer. */
export function withStrAuditVisibility<T extends Record<string, unknown>>(where: T, role: string): T & { AND?: Prisma.AuditLogWhereInput[] } {
  const exclusion = strAuditExclusion(role)
  return exclusion ? { ...where, AND: [exclusion] } : where
}
