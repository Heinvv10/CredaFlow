import type { UserRole } from "@prisma/client"

/**
 * Operator staff: bound to an Operator, never to a tenant (the database's
 * User_operator_binding_check). They are deliberately absent from
 * ROLE_HIERARCHY, so no tenant role gate admits them; their only way to a
 * lender's borrower data is a TenantSupportGrant (lib/operator/tenant-access.ts).
 */
export const OPERATOR_ROLES = ["OPERATOR_ADMIN", "OPERATOR_SUPPORT"] as const satisfies readonly UserRole[]

export type OperatorRole = (typeof OPERATOR_ROLES)[number]

export function isOperatorRole(role: unknown): role is OperatorRole {
  return typeof role === "string" && (OPERATOR_ROLES as readonly string[]).includes(role)
}

/** Lender staff roles that may grant an operator user support access. */
export const SUPPORT_GRANTER_ROLES = ["ADMIN", "SUPER_ADMIN"] as const satisfies readonly UserRole[]

/**
 * What a support grant lets the operator user act as inside the lender: the
 * lowest staff role, so read-only routes only. Never a write role.
 */
export const SUPPORT_ACCESS_ROLE = "READONLY" as const satisfies UserRole
