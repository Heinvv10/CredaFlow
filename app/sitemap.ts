import type { MetadataRoute } from "next"
import { siteUrl } from "@/lib/seo/metadata"
import { PUBLIC_SITE_ROUTES } from "@/lib/website/routes"
import { getWebsiteIdentity } from "@/lib/website/identity"

// The kept public pages on this deployment's own site URL
// (NEXT_PUBLIC_WEBSITE_URL). Unset, there is no site to map: an empty sitemap
// rather than one naming another host.
// The insurance page 404s for a lender with no FSP number, so it is not mapped.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl()
  if (!base) return []
  const holdsFsp = !!(await getWebsiteIdentity())?.fspNumber
  const now = new Date()
  return PUBLIC_SITE_ROUTES.filter((route) => holdsFsp || route !== "/site/products/insurance").map((route) => ({
    url: `${base}${route === "/" ? "" : route}`,
    lastModified: now,
    changeFrequency: route === "/" ? "weekly" : "monthly",
    priority: route === "/" ? 1 : route.includes("products") || route.includes("apply") ? 0.8 : 0.7,
  }))
}
