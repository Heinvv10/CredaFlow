import { definePermissions } from "../define"

// A plain role is the minimum for both the server map (lib/auth-guards.ts) and
// the client-safe map (lib/permissions.ts). The object forms record where the
// two maps differed when they were merged here; they are kept as they were.
export default definePermissions({
  disburse_loan: "LOAN_ADMIN",
  approve_loan: "LOAN_ADMIN",
  decline_loan: { server: "LOAN_ADMIN", client: "CREDIT_OFFICER" },
  delete_client: "ADMIN",
  manage_users: "BRANCH_MANAGER",
  view_reports: "READONLY",
  manage_settings: "ADMIN",
  view_audit_log: "LOAN_ADMIN",
  manage_branches: "ADMIN",
  // The server map gained this key late: canDo(role, "record_payment")
  // server-side was unusable while only the client-safe map had it.
  record_payment: "CREDIT_OFFICER",
  manage_insurance: { client: "INSURANCE_OFFICER" },
  manage_collections: { client: "COLLECTIONS_OFFICER" },
} as const)
