import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // PEP / sanctions screening and FIC registers (lib/screening, lib/fic).
  // Non-null tenantId; every query passes it explicitly because the screening
  // cron and the submit-time run execute outside a request frame.
  "ScreeningCheck",
  "CashThresholdReport",
  "SuspiciousReportCase",
  "SuspiciousReportAccess",
  "RmcpDocument",
] as const)
