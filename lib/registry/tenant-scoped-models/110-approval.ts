import { defineTenantScopedModels } from "../define"
export default defineTenantScopedModels(["ApprovalMatrixVersion", "ApprovalCase", "ApprovalStep", "ApprovalEscalation", "ApprovalDelegation", "CreditCommitteeDecision", "ApprovalConditionClearance"] as const)
