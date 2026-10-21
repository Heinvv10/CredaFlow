import { definePermissions } from "../define"

// Learning loop (docs/learning-loop/DESIGN.md §6): the decision-performance
// report at /reports/decision-performance, approval-to-outcome rates by
// cohort, policy and override. Read-only, per lender, ADMIN and above only
// (Hein, 21 Oct 2026, DESIGN.md decision 2): ADMIN stands in for the lender's
// compliance officer (there is no COMPLIANCE role, as 030-fic.ts), so ADMIN
// and SUPER_ADMIN see it; LOAN_ADMIN and every role below are refused.
export default definePermissions({
  view_decision_performance: "ADMIN",
} as const)
