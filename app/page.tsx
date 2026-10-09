import type { Metadata } from "next"
import { HomePage } from "@/components/website/HomePage"
import { WebsiteShell } from "@/components/website/WebsiteShell"
import { buildPageMetadata } from "@/lib/seo/metadata"
import { faqLd } from "@/lib/seo/jsonld"
import { getWebsiteIdentity } from "@/lib/website/identity"
import { getTenantPublicProductsServer } from "@/lib/public-loan-products-server"
import { homeFaqs } from "./(website)/site/home-faqs"

// Rendered per request: the page prints the request tenant's own identity,
// which a build-time prerender has no tenant to read.
export const dynamic = "force-dynamic"

export async function generateMetadata(): Promise<Metadata> {
  const identity = await getWebsiteIdentity()
  return buildPageMetadata({
    identity,
    title: "Credit and insurance — South Africa",
    description: identity
      ? `${identity.tradingName} offers responsible credit and insurance enquiries for South Africans. NCR-registered (${identity.ncrNumber}) with POPIA-aware processes.`
      : "",
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
  return (
    <WebsiteShell jsonLdId="home-organization" jsonLd={identity ? [faqLd(homeFaqs(identity, products))] : []} regulatoryBand>
      {identity && <HomePage identity={identity} products={products} />}
    </WebsiteShell>
  )
}
