import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PortalShell } from "@/components/app-shell/PortalShell"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { authorisedEntityIdsForClient } from "@/lib/asset-finance/portal-access"

export default async function PortalLayout({ children }: { children: React.ReactNode }) {
  const session = await auth()
  if (!session?.user) redirect("/portal/login")
  // Staff who land in the portal accidentally bounce back to the workspace.
  // The original portal path is intentionally dropped: staff have no business
  // following a deep client-portal link, and preserving it as a callbackUrl
  // would just route them in a circle through /login.
  if (session.user.role !== "CLIENT") redirect("/dashboard")

  const userName = session.user.name || session.user.email || ""
  const tenantConfig = session.user.tenantId ? await getTenantConfig(session.user.tenantId) : null
  // The Business link shows only for a client who may act for an entity; the
  // pages and API enforce the same rule on every request.
  const tenantId = session.user.tenantId
  const showBusiness =
    tenantId && resolveFeatureFlags(tenantConfig).featureAssetFinance
      ? (await authorisedEntityIdsForClient(tenantId, session.user.id)).length > 0
      : false

  return (
    <TenantThemeProvider config={tenantConfig}>
      <PortalShell
        userName={userName}
        userEmail={session.user.email}
        showBusiness={showBusiness}
      >
        {children}
      </PortalShell>
    </TenantThemeProvider>
  )
}
