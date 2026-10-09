import type { MetadataRoute } from "next"
import { siteUrl } from "@/lib/seo/metadata"
import { PUBLIC_SITE_ROUTES } from "@/lib/website/routes"

// Explicit allow-list of public marketing routes: the same list app/sitemap.ts
// maps (lib/website/routes.ts). We don't blanket-disallow /site/ — that's
// friendlier to crawlers and AI agents (no default-deny on the marketing tree).
// Genuine non-public pages under /site/ must be added to the disallow list
// explicitly.
export default function robots(): MetadataRoute.Robots {
  const base = siteUrl()
  return {
    rules: [
      {
        userAgent: "*",
        allow: [...PUBLIC_SITE_ROUTES],
        disallow: [
          "/dashboard/",
          "/applications/",
          "/clients/",
          "/collections/",
          "/compliance/",
          "/crm/",
          "/disbursements/",
          "/insurance/",
          "/loans/",
          "/payments/",
          "/reports/",
          "/settings/",
          "/api/",
          "/portal/",
          "/login",
          "/register",
          "/forgot-password",
          "/reset-password",
        ],
      },
    ],
    // Unset NEXT_PUBLIC_WEBSITE_URL: no sitemap or host line rather than another site's.
    ...(base ? { sitemap: `${base}/sitemap.xml`, host: base } : {}),
  }
}
