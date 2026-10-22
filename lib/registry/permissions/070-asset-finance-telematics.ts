import { definePermissions } from "../define"

// Tracker/telematics (docs/asset-finance/SLICE5.md part B). Both are the
// act_on_collections list, not a minimum role: a minimum of COLLECTIONS_OFFICER
// would admit INSURANCE_OFFICER, which has no loan-book access (POPIA least
// privilege, 050-insurance-officer-scope.ts). READONLY never holds them.
export default definePermissions({
  // Reveal a financed asset's last known position (logged per view).
  view_asset_position: ["COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
  // Acknowledge and resolve tracker alerts (the collections/recovery work queue).
  work_telematics_alerts: ["COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"],
} as const)
