import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { resolveFeatureFlags } from "@/lib/tenant"

/**
 * Per-tenant kill switch for the insurance module's API surface.
 *
 * `app/(dashboard)/insurance/layout.tsx` already redirects the staff PAGES when
 * `featureIms` is off, but that only hides the module — every route under
 * `app/api/insurance/**` was reachable by any authenticated staff member with
 * the right role. Call this INSIDE the `withTenantContext` callback so the flag
 * is read from the tenant that wrapper already resolved:
 *
 * ```ts
 * return withTenantContext(req, async (tenant) => {
 *   const blocked = await requireImsEnabled(tenant.id)
 *   if (blocked) return blocked
 *   ...
 * })
 * ```
 *
 * Deliberately NOT `getTenantFeatures()`: that resolver reads request headers
 * and is React-cached for a Server Component render tree, neither of which
 * applies in a route handler.
 *
 * Deliberately NOT `getTenantConfig()` either, even though it reads the same
 * row. That resolver wraps its query in `unstable_cache` with
 * `revalidate: 300`, and nothing in this repo calls `revalidateTag` — so a flag
 * flipped off stayed EFFECTIVE for up to five minutes on every running
 * instance. A kill switch that cannot be pulled immediately is not a kill
 * switch, so this reads the live row: one uncached lookup on
 * `TenantConfig.tenantId`, which is `@unique` and therefore an index hit,
 * selecting only the two flag columns. `resolveFeatureFlags` still does the
 * interpreting, so this gate and every other read the flag identically.
 *
 * Returns 404, not 403: a module a tenant has not bought should not confirm its
 * own existence. That also matches what the staff pages already do — a redirect
 * leaves no trace of the surface either.
 *
 * Fails CLOSED. Any throw while resolving the config (DB down, missing tenant)
 * yields the same 404 as an explicitly-off flag; `resolveFeatureFlags` already
 * treats a missing TenantConfig row as off for the same reason.
 */
export async function requireImsEnabled(tenantId: string): Promise<NextResponse | null> {
  let enabled = false
  try {
    const config = await prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { featureCrm: true, featureIms: true },
    })
    enabled = resolveFeatureFlags(config).featureIms
  } catch {
    enabled = false
  }
  if (!enabled) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }
  return null
}
