import { definePermissions } from "../define"

// Loan changes (lib/loan-changes/, lib/maker-checker/). A LOAN_ADMIN proposes; an ADMIN approves, and the maker and the
// checker are different people whatever their roles (CHECK ChangeRequest_four_eyes).
export default definePermissions({
  // Draft, edit, submit and withdraw a change to a loan.
  propose_loan_change: "LOAN_ADMIN",
  // Approve or reject a submitted loan change (never one's own). Applying it writes the loan.
  approve_loan_change: "ADMIN",
} as const)
