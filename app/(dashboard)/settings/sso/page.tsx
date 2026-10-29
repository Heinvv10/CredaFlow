import { requireMinRole } from "@/lib/auth-guards"
import { getStaffTenantId } from "@/lib/session-tenant"
import { canDo } from "@/lib/permissions"
import { requireAppBaseUrl } from "@/lib/config/deployment-urls"
import { connectionView, getConnection } from "@/lib/sso/connection"
import { Header } from "@/components/layout/Header"
import { SsoConnectionCard } from "@/components/settings/SsoConnectionCard"

export const metadata = {
  title: "Single sign-on — Settings",
}

export default async function SsoSettingsPage() {
  // Visible to ADMIN and above; only a Super Admin in a TOTP-verified session changes it (lib/sso/admin-guard.ts).
  const user = await requireMinRole("ADMIN")
  const tenantId = await getStaffTenantId()
  const connection = connectionView(await getConnection(tenantId))
  const base = requireAppBaseUrl()

  return (
    <>
      <Header
        title="Single sign-on"
        subtitle="Sign staff in with the lender's identity provider."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Single sign-on" }]}
      />
      <div className="max-w-5xl space-y-6 p-4 lg:p-8">
        <SsoConnectionCard
          initial={connection}
          redirectUri={`${base}/api/auth/sso/oidc/callback`}
          acsUrl={`${base}/api/auth/sso/saml/acs`}
          canManage={canDo(user.role, "manage_sso") && user.totpVerified === true}
        />
      </div>
    </>
  )
}
