import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Dealer/broker portal and commission (docs/asset-finance/SLICE5.md part A).
  // Non-null tenantId, passed explicitly on every query; RLS policy in
  // migration 20261019120100_dealer_portal.
  "Dealer",
  "DealerUser",
  "DealerCommissionRate",
  "DealerCommissionLine",
  "DealerPayableRun",
  "DealerPayableRunLine",
  "DealerBankAccount",
  "DealerConsentAttestation",
  "DealerDocumentRequest",
] as const)
