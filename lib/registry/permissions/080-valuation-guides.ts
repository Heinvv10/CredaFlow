import { definePermissions } from "../define"

// Valuation guides (docs/asset-finance/SLICE5.md part C).
export default definePermissions({
  // Upload, publish (a second person: CHECK ValuationGuide_four_eyes) and
  // discard a valuation guide. Recording a guide value on an asset stays
  // manage_asset_finance, like any other valuation.
  manage_valuation_guides: "LOAN_ADMIN",
} as const)
