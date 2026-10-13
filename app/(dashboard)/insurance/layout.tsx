import { redirect } from "next/navigation"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { getStaffTenantId } from "@/lib/session-tenant"

// Mirrors the sidebar's "ims" nav-group gate (lib/navigation.ts) so every
// route under /insurance — not just the hub — redirects a direct-URL bypass
// when the tenant has featureIms off.
export default async function InsuranceLayout({ children }: { children: React.ReactNode }) {
  // The session's tenant, as the dashboard layout and the pages beneath read
  // it — not the request host's.
  const { featureIms } = resolveFeatureFlags(await getTenantConfig(await getStaffTenantId()))
  if (!featureIms) redirect("/dashboard")

  return <>{children}</>
}
