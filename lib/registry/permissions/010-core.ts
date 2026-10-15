import { definePermissions } from "../define"

// The minimum role per permission, read by the server (lib/auth-guards.ts) and
// the client-safe helper (lib/permissions.ts) alike.
export default definePermissions({
  disburse_loan: "LOAN_ADMIN",
  approve_loan: "LOAN_ADMIN",
  decline_loan: "LOAN_ADMIN",
  delete_client: "ADMIN",
  manage_users: "BRANCH_MANAGER",
  view_reports: "READONLY",
  manage_settings: "ADMIN",
  view_audit_log: "LOAN_ADMIN",
  manage_branches: "ADMIN",
  record_payment: "CREDIT_OFFICER",
  manage_insurance: "INSURANCE_OFFICER",
  manage_collections: "COLLECTIONS_OFFICER",
} as const)
