import type { Metadata } from "next"
import { HomePage } from "@/components/website/HomePage"
import { WebsiteShell } from "@/components/website/WebsiteShell"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getTenantPublicProductsServer } from "@/lib/public-loan-products-server"
import { homeFaqs } from "./(website)/site/home-faqs"
import { getLocale } from "@/lib/i18n/server"
import { homeDescription, homeTitle } from "@/lib/website/home-metadata"
import { getSiteJurisdiction } from "@/lib/website/site-jurisdiction.server"
import { getResolvedTenantId } from "@/lib/tenant"
import { getWebsiteImageryView } from "@/lib/config/website-imagery"

// Rendered per request: the page prints the request tenant's own identity,
// which a build-time prerender has no tenant to read.
export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const [identity, site] = await Promise.all([getWebsiteIdentity(), getSiteJurisdiction()])
  return buildPageMetadata({
    identity,
    title: homeTitle(site),
    description: identity ? homeDescription(identity, site) : "",
    path: "/",
  })
}

// Home (`/`) is outside the (website) route group, so it does not inherit its
// layout; it uses the same WebsiteShell (site-wide JSON-LD, nav, footer and
// the support widget) directly, plus the regulatory band.
//
// The FAQPage block mirrors the visible home FAQ exactly: both come from
// homeFaqs(), so the visible Q&A and the structured data can't drift apart.
export default async function Home() {
  const identity = await getWebsiteIdentity()
  const products = identity ? await getTenantPublicProductsServer() : []
  const locale = await getLocale()
  const site = await getSiteJurisdiction()
  const faqs = identity ? homeFaqs(identity, products, locale, site) : []
  const imagery = identity ? await getWebsiteImageryView(await getResolvedTenantId()) : null
  return (
    <WebsiteShell jsonLdId="home-organization" jsonLd={faqs.length > 0 ? [faqLd(faqs)] : []} regulatoryBand>
      {identity && <HomePage identity={identity} products={products} locale={locale} site={site} imagery={imagery} />}
    </WebsiteShell>
  )
}
