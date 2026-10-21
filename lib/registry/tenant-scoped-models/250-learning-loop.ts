import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // The append-only decision log (lib/learning-loop/decision-log.ts).
  "CreditDecisionRecord",
  // Outcomes derived from it nightly (lib/learning-loop/outcomes/).
  "DecisionOutcome",
] as const)
