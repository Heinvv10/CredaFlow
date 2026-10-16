import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Daily per-loan arrears history for the NCR return (lib/reports/arrears-snapshot.ts).
  "LoanArrearsSnapshot",
] as const)
