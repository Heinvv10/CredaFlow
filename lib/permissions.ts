/**
 * Client-safe permissions helper — use this in React components to show/hide UI elements.
 * Mirrors the server-side canDo() logic in lib/auth-guards.ts
 */

import { CLIENT_PERMISSIONS } from "@/lib/registry/generated/permissions"

export type UserRole =
  | "SUPER_ADMIN"
  | "ADMIN"
  | "LOAN_ADMIN"
  | "CREDIT_OFFICER"
  | "COLLECTIONS_OFFICER"
  | "COLLECTIONS_AGENT"
  | "INSURANCE_OFFICER"
  | "BRANCH_MANAGER"
  | "READONLY"
  // Operator staff (lib/operator/). Deliberately absent from ROLE_HIERARCHY:
  // hasMinRole denies them every tenant permission.
  | "OPERATOR_ADMIN"
  | "OPERATOR_SUPPORT"

export const ROLE_HIERARCHY: UserRole[] = [
  "READONLY",
  "COLLECTIONS_OFFICER",
  "COLLECTIONS_AGENT",
  "INSURANCE_OFFICER",
  "CREDIT_OFFICER",
  "LOAN_ADMIN",
  "BRANCH_MANAGER",
  "ADMIN",
  "SUPER_ADMIN",
]

// Who may be a branch's manager: the roles the branch settings picker offers
// and the only ones POST /api/branches accepts.
export const BRANCH_MANAGER_ROLES: UserRole[] = ["BRANCH_MANAGER", "LOAN_ADMIN", "SUPER_ADMIN", "ADMIN"]

export function hasMinRole(userRole: UserRole, minRole: UserRole): boolean {
  const userIdx = ROLE_HIERARCHY.indexOf(userRole)
  const minIdx = ROLE_HIERARCHY.indexOf(minRole)
  // Unknown role (not in hierarchy) → deny. Mirrors lib/auth-guards.ts hasMinRole.
  if (userIdx < 0 || minIdx < 0) return false
  return userIdx >= minIdx
}

// One file per domain under lib/registry/permissions/ (merged by
// scripts/gen-registries.ts; docs/ARCHITECTURE.md, "Registries").
const PERMISSIONS: Record<string, UserRole> = CLIENT_PERMISSIONS

export function canDo(userRole: UserRole | string, permission: string): boolean {
  const minRole = PERMISSIONS[permission]
  if (!minRole) return false
  return hasMinRole(userRole as UserRole, minRole)
}
