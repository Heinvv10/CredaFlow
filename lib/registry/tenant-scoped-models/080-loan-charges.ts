import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Derived default charges (lib/loan/charges-sync.ts). Non-null tenantId;
  // every query passes it explicitly because the sync also runs outside a
  // request frame.
  "LoanCharge",
] as const)
