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
import { publicLenderLogoSrc } from "@/lib/config/lender-logo"
import { I18nProvider } from "@/lib/i18n/client"
import { clientMessages, getLocale, getTenantEnabledLocales } from "@/lib/i18n/server"
import { WEBSITE_CLIENT_NAMESPACES } from "@/lib/i18n/surfaces"

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
  const tenantId = await getResolvedTenantId()
  const [theme, locale, enabledLocales, logoSrc] = await Promise.all([
    getTenantConfig(tenantId),
    getLocale(),
    getTenantEnabledLocales(tenantId),
    publicLenderLogoSrc(tenantId),
  ])

  return (
    <TenantThemeProvider config={theme}>
      <WebsiteIdentityProvider identity={identity}>
        <I18nProvider locale={locale} messages={clientMessages(locale, WEBSITE_CLIENT_NAMESPACES)}>
          <div lang={locale} className="flex min-h-screen flex-col bg-[#11141b] text-white">
            <WebsiteAnalytics />
            <JsonLd id={jsonLdId} data={[organizationLd(identity), webSiteLd(identity), ...jsonLd]} />
            <NavBar enabledLocales={enabledLocales} logoSrc={logoSrc} />
            {regulatoryBand && <RegulatoryBand identity={identity} />}
            <main className="flex-1">{children}</main>
            <Footer identity={identity} locale={locale} />
            <WebsiteSupport whatsappE164={identity.publicWhatsappE164} />
          </div>
        </I18nProvider>
      </WebsiteIdentityProvider>
    </TenantThemeProvider>
  )
}
