import { definePermissions } from "../define"

// Business-configurable decisioning and maker-checker (lib/decisioning/,
// lib/maker-checker/). A LOAN_ADMIN drafts; an ADMIN approves. The maker and
// the checker of one change are different people whatever their roles (CHECK
// ChangeRequest_four_eyes), so an ADMIN who drafted needs another ADMIN.
export default definePermissions({
  // Read rule sets, scorecards, pending changes and automatic decision runs.
  view_decision_rules: "LOAN_ADMIN",
  // Draft, edit and submit a rule set, scorecard or engine-config change; run a simulation.
  manage_decision_rules: "LOAN_ADMIN",
  // Approve or reject a submitted decisioning change (never one's own).
  approve_decision_rules: "ADMIN",
  // Approve engine settings that put the engine LIVE or record the lender's s71 sign-off of automated
  // declines: a SUPER_ADMIN, with the session's second factor where the lender requires one
  // (lib/maker-checker/service.ts). A drafting ADMIN's colleague ADMIN cannot wave it through.
  approve_decision_engine_live: "SUPER_ADMIN",
} as const)
