import NavBar from "@/components/website/NavBar"
import Footer from "@/components/website/Footer"
import { RegulatoryBand } from "@/components/website/RegulatoryBand"
import { WebsiteIdentityProvider } from "@/components/website/WebsiteIdentity"
import { WebsiteNotConfigured } from "@/components/website/WebsiteNotConfigured"
import { JsonLd } from "@/components/seo/JsonLd"
import { WebsiteAnalytics } from "@/components/analytics/WebsiteAnalytics"
import { WebsiteSupport } from "@/components/support/WebsiteSupport"
import { organizationLd, webSiteLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { TenantThemeProvider } from "@/components/TenantThemeProvider"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"

/**
 * The public website's frame, shared by `/` and the (website) route group:
 * analytics, the site-wide JSON-LD, nav, footer and the support widget, all
 * printing the tenant's own identity. Without an identity it renders the
 * not-configured state instead of the page.
 */
export async function WebsiteShell({
  children,
  jsonLdId,
  jsonLd = [],
  regulatoryBand = false,
}: {
  children: React.ReactNode
  jsonLdId: string
  /** Page-level JSON-LD emitted alongside the site-wide nodes. */
  jsonLd?: object[]
  regulatoryBand?: boolean
}) {
  const identity = await getWebsiteIdentity()
  if (!identity) return <WebsiteNotConfigured />
  const theme = await getTenantConfig(await getResolvedTenantId())

  return (
    <TenantThemeProvider config={theme}>
      <WebsiteIdentityProvider identity={identity}>
        <div className="flex min-h-screen flex-col bg-[#11141b] text-white">
          <WebsiteAnalytics />
          <JsonLd id={jsonLdId} data={[organizationLd(identity), webSiteLd(identity), ...jsonLd]} />
          <NavBar />
          {regulatoryBand && <RegulatoryBand identity={identity} />}
          <main className="flex-1">{children}</main>
          <Footer identity={identity} />
          <WebsiteSupport whatsappE164={identity.publicWhatsappE164} />
        </div>
      </WebsiteIdentityProvider>
    </TenantThemeProvider>
  )
}
