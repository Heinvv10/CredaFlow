import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { resolveFeatureFlags } from "@/lib/tenant"

/**
 * Per-tenant kill switch for the asset-finance API surface
 * (`TenantConfig.featureAssetFinance`, docs/asset-finance/DESIGN.md D9).
 * Call it INSIDE the `withTenantContext` callback of every route under
 * `app/api/asset-finance/**`.
 *
 * Same contract as `lib/insurance/require-ims-enabled.ts`: reads the live row
 * uncached (a kill switch must take effect at once), interprets it through
 * `resolveFeatureFlags`, answers 404 rather than 403 (a module a tenant has not
 * bought does not confirm it exists), and fails CLOSED on any error.
 */
export async function requireAssetFinanceEnabled(tenantId: string): Promise<NextResponse | null> {
  let enabled = false
  try {
    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { featureCrm: true, featureIms: true, featureAssetFinance: true },
    })
    enabled = resolveFeatureFlags(config).featureAssetFinance
  } catch (error) {
    console.warn("[asset-finance] feature flag lookup failed; failing closed", { tenantId, error: String(error) })
    enabled = false
  }
  if (!enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  return null
}
