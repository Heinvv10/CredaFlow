import { definePermissions } from "../define"

// Loan-money writes (Fair Score audit, 2026-10-16: an INSURANCE_OFFICER
// recorded a payment, POST /api/payments 200).
//
// capture_payment is the one explicit list: its ladder minimum,
// COLLECTIONS_AGENT, ranks below INSURANCE_OFFICER, so a minimum cannot leave
// INSURANCE_OFFICER out. It is exactly the roles that minimum allowed, minus
// INSURANCE_OFFICER. The other four are ladder minimums (a role added to the
// ladder inherits them); INSURANCE_OFFICER ranks below each, so they are a
// named, second layer on routes whose own minimum already refused it.
export default definePermissions({
  // POST /api/payments: a manual receipt against a loan.
  capture_payment: ["COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // "Amend loan amount": return a reviewed application to draft to re-quote it.
  amend_application: "LOAN_ADMIN",
  // Edit or submit a draft application (PATCH /api/applications/[id]).
  edit_application: "CREDIT_OFFICER",
  // DELETE /api/applications/[id].
  cancel_application: "CREDIT_OFFICER",
  // PATCH /api/applications/[id]/affordability.
  edit_affordability: "CREDIT_OFFICER",
} as const)
