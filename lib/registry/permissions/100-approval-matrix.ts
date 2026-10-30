import { definePermissions } from "../define"

// Multi-level approval (lib/approval/). The matrix is changed only through maker-checker: an ADMIN drafts and a
// SUPER_ADMIN approves (any change: a matrix is the lender's delegated-authority policy, and two administrators could
// otherwise cut every application to one approval). Who may approve an application at a level is the matrix's own
// (levels name a role) plus delegation, not a permission.
export default definePermissions({
  view_approval_matrix: "LOAN_ADMIN",
  manage_approval_matrix: "ADMIN",
  approve_approval_matrix: "SUPER_ADMIN",
  // Delegate one's own authority; an ADMIN may record a delegation on someone else's behalf.
  manage_approval_delegations: "LOAN_ADMIN",
  manage_approval_delegations_any: "ADMIN",
  // Read the credit committee pack, and record the committee's decision (the matrix's level authority also applies).
  view_committee_pack: "LOAN_ADMIN",
  record_committee_decision: "LOAN_ADMIN",
} as const)
