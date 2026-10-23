import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Tracker/telematics (docs/asset-finance/SLICE5.md part B). Non-null
  // tenantId, passed explicitly on every query; RLS policy in migration
  // 20261020160100_telematics.
  "TrackerDevice",
  "TelematicsEvent",
  "TelematicsPosition",
  "TelematicsHeldReading",
  "TelematicsAlert",
  "TelematicsPositionAccess",
] as const)
