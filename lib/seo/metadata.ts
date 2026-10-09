import type { Metadata } from "next"
import { websiteBaseUrl } from "@/lib/config/deployment-urls"
import type { LenderIdentity } from "@/lib/config/identity-schema"

/**
 * The public site's origin, from NEXT_PUBLIC_WEBSITE_URL, or "" when unset:
 * URLs built from it then stay root-relative rather than naming another site.
 */
export function siteUrl(): string {
  return websiteBaseUrl() ?? ""
}

interface BuildPageMetadataInput {
  /** The lender whose site this is; null when its identity is not configured. */
  identity: Pick<LenderIdentity, "tradingName"> | null
  /** Page-specific title, without the brand (it is appended). */
  title: string
  /** Page-specific meta description. Should be 120–160 chars. */
  description: string
  /** Path on the public site, starting with "/" (use "/" for home). */
  path: string
}

/** Metadata for a site whose lender identity is not configured: names no one, indexed by no one. */
export const NOT_CONFIGURED_METADATA: Metadata = {
  title: "Website not configured",
  robots: { index: false, follow: false },
}

/**
 * Build a Next.js Metadata object with canonical URL, OpenGraph and Twitter
 * card metadata. Used by public marketing pages — do not use for portal,
 * dashboard, admin, or any authenticated route.
 */
export function buildPageMetadata({ identity, title, description, path }: BuildPageMetadataInput): Metadata {
  if (!identity) return NOT_CONFIGURED_METADATA
  const fullTitle = `${title} | ${identity.tradingName}`
  const base = siteUrl()
  const url = base ? `${base}${path === "/" ? "" : path}` : undefined

  return {
    title: fullTitle,
    description,
    ...(url ? { alternates: { canonical: url } } : {}),
    openGraph: {
      type: "website",
      ...(url ? { url } : {}),
      siteName: identity.tradingName,
      title: fullTitle,
      description,
    },
    twitter: {
      card: "summary",
      title: fullTitle,
      description,
    },
  }
}
