import type { UserRole } from "@/lib/permissions"

/**
 * Identity provider groups to CredaFlow staff roles. The identity provider can
 * never grant SUPER_ADMIN or an operator role: it is refused when a mapping is
 * saved (parseGroupRoleMap), by the SsoConnection CHECK constraints, and again
 * here when a mapping is read.
 */

/** Mappable roles, lowest first. SUPER_ADMIN and operator roles are deliberately absent. */
const MAPPABLE_ROLES = [
  "READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "INSURANCE_OFFICER",
  "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN",
] as const satisfies readonly UserRole[]

export type MappableRole = (typeof MAPPABLE_ROLES)[number]
export type GroupRoleMap = Record<string, MappableRole>

export const isMappableRole = (value: unknown): value is MappableRole =>
  typeof value === "string" && (MAPPABLE_ROLES as readonly string[]).includes(value)

export const MAPPABLE_ROLE_LIST: readonly MappableRole[] = MAPPABLE_ROLES

/** The map as stored, or null if it is not an object of group name to mappable role. */
export function parseGroupRoleMap(value: unknown): GroupRoleMap | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const out: GroupRoleMap = {}
  for (const [group, role] of Object.entries(value)) {
    if (!group || group.length > 256 || !isMappableRole(role)) return null
    out[group] = role
  }
  return out
}

/** The highest-ranked role among the user's groups, or null when none is mapped. */
export function roleFromGroups(groups: readonly string[], map: GroupRoleMap): MappableRole | null {
  let best = -1
  for (const group of groups) {
    const role = Object.hasOwn(map, group) ? map[group] : undefined
    if (!isMappableRole(role)) continue
    best = Math.max(best, MAPPABLE_ROLES.indexOf(role))
  }
  return best < 0 ? null : MAPPABLE_ROLES[best]
}
