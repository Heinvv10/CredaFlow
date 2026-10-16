import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Daily per-loan arrears history for the NCR return (lib/reports/arrears-snapshot.ts).
  "LoanArrearsSnapshot",
  // The per-day run marker written with them.
  "ArrearsSnapshotRun",
] as const)
