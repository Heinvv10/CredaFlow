import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Bureau data submission (lib/bureau-submission). Non-null tenantId; every
  // query passes it explicitly because the crons run outside a request frame.
  "BureauSubmission",
  "BureauSubmissionRecord",
  "BureauAdverseConfirmation",
] as const)
