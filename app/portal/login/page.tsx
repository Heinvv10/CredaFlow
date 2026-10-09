import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import LoginForm from "@/components/auth/LoginForm"
import { safePortalPath } from "@/lib/portal-urls"
import { getLenderBrandName } from "@/lib/config/identity"
import { DeploymentConfigError, requireAppBaseUrl } from "@/lib/config/deployment-urls"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Client Portal" }

export default async function PortalLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>
}) {
  const session = await auth()
  if (session?.user) {
    if (session.user.role !== "CLIENT") redirect("/dashboard")
    // A consumer who is ALREADY signed in must still reach the page the link
    // named. Dropping callbackUrl here silently discards the destination for
    // anyone with a live session — a "sign your agreement" link lands them on
    // the portal home with no indication of what they were sent to do. That is
    // the common case on a phone, where the session outlives the click.
    // Allowlisted: caller-supplied and reaches a redirect.
    const { callbackUrl } = await searchParams
    redirect(safePortalPath(callbackUrl) ?? "/portal")
  }
  const tenantId = await getResolvedTenantId()
  const [brandName, config] = await Promise.all([getLenderBrandName(tenantId), getTenantConfig(tenantId)])
  // The staff app lives on its own host: omit the link when that host is not configured.
  let crossLink: { href: string; label: string } | null = null
  try {
    crossLink = { href: `${requireAppBaseUrl()}/login`, label: "Are you staff? Sign in to the workspace" }
  } catch (err) {
    if (!(err instanceof DeploymentConfigError)) throw err
  }
  return (
    <TenantThemeProvider config={config}>
      <LoginForm variant="client" brandName={brandName} crossLink={crossLink} />
    </TenantThemeProvider>
  )
}
