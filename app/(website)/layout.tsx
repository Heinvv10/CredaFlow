import type { Metadata } from "next"
import { WebsiteShell } from "@/components/website/WebsiteShell"
import { NOT_CONFIGURED_METADATA } from "@/lib/seo/metadata"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getSiteJurisdiction } from "@/lib/website/site-jurisdiction.server"

// Rendered per request: the page prints the request tenant's own identity,
// which a build-time prerender has no tenant to read.
export const dynamic = "force-dynamic"

// Fallback metadata for any (website) page that does not export its own.
// Per-page metadata is preferred — see lib/seo/metadata.ts.
export async function generateMetadata(): Promise<Metadata> {
  const [identity, site] = await Promise.all([getWebsiteIdentity(), getSiteJurisdiction()])
  if (!identity) return NOT_CONFIGURED_METADATA
  return {
    title: identity.tradingName,
    description: site.nca
      ? `${identity.tradingName} — registered credit provider${identity.ncrNumber ? ` ${identity.ncrNumber}` : ""}.`
      : `${identity.tradingName} — credit provider in ${site.countryName}.`,
    openGraph: { type: "website", siteName: identity.tradingName, title: identity.tradingName },
    twitter: { card: "summary", title: identity.tradingName },
  }
}

export default function WebsiteLayout({ children }: { children: React.ReactNode }) {
  return <WebsiteShell jsonLdId="site-organization">{children}</WebsiteShell>
}
