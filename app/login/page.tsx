import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import LoginForm from "@/components/auth/LoginForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { DeploymentConfigError } from "@/lib/config/deployment-urls"
import { portalLoginUrl } from "@/lib/portal-urls"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"
import { runWithTenant } from "@/lib/tenant-scope"
import { getEnabledConnection } from "@/lib/sso/connection"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Staff sign-in" }

export default async function LoginPage() {
  const session = await auth()
  if (session?.user) {
    redirect(session.user.role === "CLIENT" ? "/portal" : "/dashboard")
  }
  const tenantId = await getResolvedTenantId()
  const [brandName, config, sso] = await Promise.all([
    getLenderBrandName(tenantId),
    getTenantConfig(tenantId),
    runWithTenant(tenantId, () => getEnabledConnection(tenantId)),
  ])
  // The portal lives on its own host: omit the link when that host is not configured.
  let crossLink: { href: string; label: string } | null = null
  try {
    crossLink = { href: portalLoginUrl(null), label: "Are you a client? Sign in to the portal" }
  } catch (err) {
    if (!(err instanceof DeploymentConfigError)) throw err
  }
  return (
    <TenantThemeProvider config={config}>
      <LoginForm variant="staff" brandName={brandName} crossLink={crossLink} ssoEnabled={sso !== null} />
    </TenantThemeProvider>
  )
}
