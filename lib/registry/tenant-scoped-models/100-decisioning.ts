import { defineTenantScopedModels } from "../define"
export default defineTenantScopedModels(["ChangeRequest", "DecisionRuleSetVersion", "DecisionEngineConfig", "AutoDecisionRun"] as const)
