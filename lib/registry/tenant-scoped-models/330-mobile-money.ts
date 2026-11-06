import { defineTenantScopedModels } from "../define"
// M-Pesa transactions (lib/mobile-money): non-null tenantId, passed explicitly on every query.
export default defineTenantScopedModels(["MobileMoneyTransaction"] as const)
