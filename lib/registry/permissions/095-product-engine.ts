import { definePermissions } from "../define"

// Product versions and pricing rules (lib/product-engine/, lib/maker-checker/). A LOAN_ADMIN drafts; an ADMIN approves,
// and the maker and the checker are different people whatever their roles (CHECK ChangeRequest_four_eyes).
export default definePermissions({
  // Read versions, pricing rules and pending changes.
  view_product_versions: "LOAN_ADMIN",
  // Draft, edit and submit a product version or a pricing rule (or its retirement).
  manage_product_versions: "LOAN_ADMIN",
  // Approve or reject a submitted product or pricing change (never one's own).
  approve_product_versions: "ADMIN",
  // Set the segment / channel / campaign an application is priced on.
  set_application_pricing_inputs: "CREDIT_OFFICER",
  // Name lending groups and their members (lib/product-types).
  manage_borrower_groups: "CREDIT_OFFICER",
  // Read and export the month's employer deduction list: it carries names and payroll numbers.
  view_check_off_deductions: "CREDIT_OFFICER",
} as const)
