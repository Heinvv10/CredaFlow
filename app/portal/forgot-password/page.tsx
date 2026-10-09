import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import PortalForgotPasswordForm from "@/components/auth/PortalForgotPasswordForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Reset password" }

export default async function PortalForgotPasswordPage() {
  const session = await auth()
  if (session?.user) {
    redirect(session.user.role === "CLIENT" ? "/portal" : "/dashboard")
  }
  const tenantId = await getResolvedTenantId()
  const [brandName, config] = await Promise.all([getLenderBrandName(tenantId), getTenantConfig(tenantId)])
  return (
    <TenantThemeProvider config={config}>
      <PortalForgotPasswordForm brandName={brandName} />
    </TenantThemeProvider>
  )
}
