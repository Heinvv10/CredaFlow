import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PortalShell } from "@/components/app-shell/PortalShell"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { getTenantConfig, resolveFeatureFlags } from "@/lib/tenant"
import { authorisedEntityIdsForClient } from "@/lib/asset-finance/portal-access"
import { loadPortalSigners } from "@/lib/asset-finance/signing-view"
import { portalBusinessLinkVisible } from "@/lib/asset-finance/portal-navigation"

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
  // Sureties also need the Business link to reach their signing tasks. The
  // pages and API still enforce access to each entity and signer record.
  const tenantId = session.user.tenantId
  const featureEnabled = resolveFeatureFlags(tenantConfig).featureAssetFinance
  const [authorisedEntityIds, signers] = tenantId && featureEnabled
    ? await Promise.all([
        authorisedEntityIdsForClient(tenantId, session.user.id),
        loadPortalSigners(tenantId, session.user.id),
      ])
    : [[], []]
  const showBusiness = portalBusinessLinkVisible(featureEnabled, authorisedEntityIds.length, signers.length)

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
