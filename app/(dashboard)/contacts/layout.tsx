import { redirect } from "next/navigation"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { getStaffTenantId } from "@/lib/session-tenant"

// /contacts is part of the sidebar's "crm" nav group (lib/navigation.ts),
// so it gates on featureCrm, same as /crm.
export default async function ContactsLayout({ children }: { children: React.ReactNode }) {
  // The session's tenant, as the dashboard layout and the pages beneath read
  // it — not the request host's.
  const { featureCrm } = resolveFeatureFlags(await getTenantConfig(await getStaffTenantId()))
  if (!featureCrm) redirect("/dashboard")

  return <>{children}</>
}
