import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import ResetPasswordForm from "@/components/auth/ResetPasswordForm"
import { getLenderBrandName } from "@/lib/config/identity"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"

// The lender's brand is read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Reset password" }

export default async function ResetPasswordPage() {
  const tenantId = await getResolvedTenantId()
  const [brandName, config] = await Promise.all([getLenderBrandName(tenantId), getTenantConfig(tenantId)])
  return (
    <TenantThemeProvider config={config}>
      <ResetPasswordForm brandName={brandName} />
    </TenantThemeProvider>
  )
}
