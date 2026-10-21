import { definePermissions } from "../define"

// Learning loop (docs/learning-loop/DESIGN.md §6): the decision-performance
// report at /reports/decision-performance, approval-to-outcome rates by
// cohort, policy and override. ADMIN only until Hein decides whether
// LOAN_ADMIN sees it too (DESIGN.md §11, question 2).
export default definePermissions({
  view_decision_performance: "ADMIN",
} as const)
