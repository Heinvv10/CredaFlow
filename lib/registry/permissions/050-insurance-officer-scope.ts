import { definePermissions } from "../define"

// INSURANCE_OFFICER works the insurance book, clients and compliance basics,
// not the loan book (Fair Score audit, 2026-10-16: it saw collections, asset
// finance and the board pack, a POPIA least-privilege issue). Each list is
// exactly the roles that had the access before, minus INSURANCE_OFFICER.
export default definePermissions({
  // Read the loan book: the pages and APIs in lib/security/loan-book-scope.ts,
  // enforced by proxy.ts. Every staff role but INSURANCE_OFFICER.
  view_loan_book: ["READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // Collections actions that were open from COLLECTIONS_OFFICER up: payment
  // arrangements, Section 129 issue, collections stage, attorney referral,
  // reminders.
  act_on_collections: ["COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
} as const)
