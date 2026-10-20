import { definePermissions } from "../define"

// Dealer/broker portal (docs/asset-finance/SLICE5.md part A).
export default definePermissions({
  // Dealers, their users and set-password links, commission rates, dealer
  // bank account requests and payable-run creation. Run approval, release and
  // bank account decisions stay decide_asset_finance.
  manage_dealers: "LOAN_ADMIN",
} as const)
