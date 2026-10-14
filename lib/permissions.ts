/**
 * Client-safe permissions helper — use this in React components to show/hide UI elements.
 * Mirrors the server-side canDo() logic in lib/auth-guards.ts
 */

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

const PERMISSIONS: Record<string, UserRole> = {
  disburse_loan: "LOAN_ADMIN",
  approve_loan: "LOAN_ADMIN",
  decline_loan: "CREDIT_OFFICER",
  delete_client: "ADMIN",
  manage_users: "BRANCH_MANAGER",
  view_reports: "READONLY",
  manage_settings: "ADMIN",
  view_audit_log: "LOAN_ADMIN",
  manage_branches: "ADMIN",
  record_payment: "CREDIT_OFFICER",
  manage_insurance: "INSURANCE_OFFICER",
  manage_collections: "COLLECTIONS_OFFICER",
  // Asset finance (docs/asset-finance/DESIGN.md). Keep identical to lib/auth-guards.ts.
  manage_asset_finance: "CREDIT_OFFICER",
  decide_asset_finance: "LOAN_ADMIN",
}

export function canDo(userRole: UserRole | string, permission: string): boolean {
  const minRole = PERMISSIONS[permission]
  if (!minRole) return false
  return hasMinRole(userRole as UserRole, minRole)
}
