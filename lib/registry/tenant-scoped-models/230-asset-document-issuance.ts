import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Lender-template provenance of each issued asset-finance document
  // (lib/asset-finance/documents/templates/issuance.ts). Non-null tenantId,
  // passed explicitly on every query.
  "AssetDocumentIssuance",
] as const)
