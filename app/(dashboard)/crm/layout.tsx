import { requireLoanBookPage } from "@/lib/auth-guards"
import { redirect } from "next/navigation"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { getStaffTenantId } from "@/lib/session-tenant"

// Mirrors the sidebar's "crm" nav-group gate (lib/navigation.ts) so every
// route under /crm — not just the hub — redirects a direct-URL bypass when
// the tenant has featureCrm off.
export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  // Loan book (lib/security/loan-book-scope.ts), behind proxy.ts.
  await requireLoanBookPage()
  // The session's tenant, as the dashboard layout and the pages beneath read
  // it — not the request host's.
  const { featureCrm } = resolveFeatureFlags(await getTenantConfig(await getStaffTenantId()))
  if (!featureCrm) redirect("/dashboard")

  return <>{children}</>
}
