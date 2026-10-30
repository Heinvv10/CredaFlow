import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // IFRS 9 staging, ECL and interest suspension (lib/ifrs9).
  "Ifrs9Config",
  "Ifrs9EclParameter",
  "Ifrs9SicrFlag",
  "Ifrs9Run",
  "Ifrs9LoanSnapshot",
] as const)
