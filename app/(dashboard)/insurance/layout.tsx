import { redirect } from "next/navigation"
import { getTenantFeatures } from "@/lib/tenant"

// Mirrors the sidebar's "ims" nav-group gate (lib/navigation.ts) so every
// route under /insurance — not just the hub — redirects a direct-URL bypass
// when the tenant has featureIms off.
export default async function InsuranceLayout({ children }: { children: React.ReactNode }) {
  const { featureIms } = await getTenantFeatures()
  if (!featureIms) redirect("/dashboard")

  return <>{children}</>
}
