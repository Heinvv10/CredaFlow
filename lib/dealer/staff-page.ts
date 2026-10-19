import { redirect } from "next/navigation"
import { canDo, NO_ACCESS_PAGE, type StaffUser } from "@/lib/auth-guards"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"

/**
 * The staff dealer pages (app/(dashboard)/asset-finance/dealers/**,
 * dealer-runs/**) need manage_dealers, as their API does; the asset-finance
 * layout has already checked the module flag and the loan book.
 */
export async function requireDealerStaffPage(): Promise<{ user: StaffUser; tenantId: string; canDecide: boolean }> {
  const { user, tenantId } = await requireAssetFinanceStaffPage()
  if (!canDo(user.role, "manage_dealers")) redirect(NO_ACCESS_PAGE)
  return { user, tenantId, canDecide: canDo(user.role, "decide_asset_finance") }
}
