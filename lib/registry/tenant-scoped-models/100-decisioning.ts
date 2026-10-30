import { defineTenantScopedModels } from "../define"
export default defineTenantScopedModels(["ChangeRequest", "DecisionRuleSetVersion", "DecisionEngineConfig", "AutoDecisionRun", "AutoDecisionDue"] as const)
