import { redirect } from "next/navigation"
import { getTenantFeatures } from "@/lib/tenant"

// Mirrors the sidebar's "assetFinance" nav-group gate (lib/navigation.ts) so
// every route under /asset-finance redirects a direct-URL bypass when the
// tenant has featureAssetFinance off. The API routes answer 404 on their own
// (lib/asset-finance/require-enabled.ts).
export default async function AssetFinanceLayout({ children }: { children: React.ReactNode }) {
  const { featureAssetFinance } = await getTenantFeatures()
  if (!featureAssetFinance) redirect("/dashboard")

  return <>{children}</>
}
