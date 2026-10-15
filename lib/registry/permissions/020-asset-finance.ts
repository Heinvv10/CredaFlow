import { definePermissions } from "../define"

// Asset finance (docs/asset-finance/DESIGN.md).
export default definePermissions({
  // Capture entities, deals, assets, suppliers and documents.
  manage_asset_finance: "CREDIT_OFFICER",
  // Credit decisions, NCA regime overrides, supplier bank approvals, payouts.
  decide_asset_finance: "LOAN_ADMIN",
} as const)
