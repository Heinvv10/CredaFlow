import { defineTenantScopedModels } from "../define"
export default defineTenantScopedModels(["ApprovalMatrixVersion", "ApprovalCase", "ApprovalStep", "ApprovalEscalation", "ApprovalDelegation", "CreditCommitteeDecision"] as const)
