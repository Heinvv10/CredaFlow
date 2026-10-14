import { redirect } from "next/navigation"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"

// Mirrors the sidebar's "assetFinance" nav-group gate (lib/navigation.ts,
// fed by app/(dashboard)/layout.tsx) so every route under /asset-finance
// redirects a direct-URL bypass when the tenant has featureAssetFinance off.
// The flag is read for the SESSION's tenant, the tenant every page under here
// queries (lib/asset-finance/staff-page.ts), never one resolved from the host.
// The API routes answer 404 on their own (lib/asset-finance/require-enabled.ts).
export default async function AssetFinanceLayout({ children }: { children: React.ReactNode }) {
  const { tenantId } = await requireAssetFinanceStaffPage()
  const { featureAssetFinance } = resolveFeatureFlags(await getTenantConfig(tenantId))
  if (!featureAssetFinance) redirect("/dashboard")

  return <>{children}</>
}
