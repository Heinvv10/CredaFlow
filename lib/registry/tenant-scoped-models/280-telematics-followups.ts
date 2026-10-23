import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Telematics follow-ups (docs/asset-finance/SLICE5-FOLLOWUPS.md part T). RLS
  // policy in migration 20261022110100_telematics_followups.
  "AssetTheftReport",
  "AssetMeterReadingVoid",
  "TrackerClosure",
] as const)
