import { definePermissions } from "../define"

// Loan-money writes, as explicit role lists rather than ladder minimums.
// INSURANCE_OFFICER ranks above the collections roles on the ladder, so a
// minimum of COLLECTIONS_AGENT handed it payment capture (Fair Score audit,
// 2026-10-16: POST /api/payments 200 for an insurance officer). Each list is
// exactly the roles the route's ladder gate allowed before, minus
// INSURANCE_OFFICER: no role gains anything.
export default definePermissions({
  // POST /api/payments: a manual receipt against a loan.
  capture_payment: ["COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // "Amend loan amount": return a reviewed application to draft to re-quote it.
  amend_application: ["LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // Edit or submit a draft application (PATCH /api/applications/[id]).
  edit_application: ["CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // DELETE /api/applications/[id].
  cancel_application: ["CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // PATCH /api/applications/[id]/affordability.
  edit_affordability: ["CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
} as const)
