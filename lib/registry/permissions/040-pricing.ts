import { definePermissions } from "../define"

// Lending prices.
export default definePermissions({
  // Record and four-eyes approve the SARB repo rate, which sets the NCA
  // interest-rate cap on unsecured credit (lib/loan/nca-interest-cap.ts). Every
  // lender needs it, asset finance or not.
  manage_repo_rate: "LOAN_ADMIN",
} as const)
