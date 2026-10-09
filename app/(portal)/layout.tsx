import { auth } from "@/lib/auth"
import { redirect } from "next/navigation"
import { PortalShell } from "@/components/app-shell/PortalShell"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { getTenantConfig } from "@/lib/tenant"

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

  return (
    <TenantThemeProvider config={tenantConfig}>
      <PortalShell
        userName={userName}
        userEmail={session.user.email}
      >
        {children}
      </PortalShell>
    </TenantThemeProvider>
  )
}
