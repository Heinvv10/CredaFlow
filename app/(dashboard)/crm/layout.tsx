import { redirect } from "next/navigation"
import { getTenantFeatures } from "@/lib/tenant"

// Mirrors the sidebar's "crm" nav-group gate (lib/navigation.ts) so every
// route under /crm — not just the hub — redirects a direct-URL bypass when
// the tenant has featureCrm off.
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const { featureCrm } = await getTenantFeatures()
  if (!featureCrm) redirect("/dashboard")

  return <>{children}</>
}
