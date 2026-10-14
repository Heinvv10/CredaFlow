import { canDo, requireMinRole, type StaffUser } from "@/lib/auth-guards"

/**
 * The staff-page half of the API guards: any staff role reads. The tenant is
 * the signed-in user's own (never a resolved or default tenant). The feature
 * flag is checked by app/(dashboard)/asset-finance/layout.tsx.
 */
export async function requireAssetFinanceStaffPage(): Promise<{ user: StaffUser; tenantId: string; canManage: boolean }> {
  const user = await requireMinRole("READONLY")
  return { user, tenantId: user.tenantId, canManage: canDo(user.role, "manage_asset_finance") }
}
