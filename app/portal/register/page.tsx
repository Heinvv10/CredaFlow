import PortalRegisterForm from "./PortalRegisterForm"
import { WebsiteAnalytics } from "@/components/analytics/WebsiteAnalytics"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"

// The tenant's colours are read from the DB per request, so this page cannot be
// prerendered at build time.
export const dynamic = "force-dynamic"

export const metadata = { title: "Create client portal account" }

export default async function PortalRegisterPage() {
  const config = await getTenantConfig(await getResolvedTenantId())
  return (
    <TenantThemeProvider config={config}>
      {/* Register is the pre-auth tail of the public acquisition funnel, so it
          loads the same analytics bootstrap as the marketing site (this route
          sits outside the (website) group and would otherwise have no _paq).
          customUrl pins the reported URL to the bare path: this route is reached
          via /portal/register?email=…&reference=… deep links, and that email is
          PII that must never reach a third-party analytics tracker. */}
      <WebsiteAnalytics customUrl="/portal/register" />
      <PortalRegisterForm />
    </TenantThemeProvider>
  )
}
