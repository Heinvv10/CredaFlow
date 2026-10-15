import type { Namespace } from "./catalog"

/**
 * The namespaces each surface's client components read through useT(). The
 * layout sends only these to the browser; a client component reading a
 * namespace missing here throws under a non-English locale (lib/i18n/client.tsx),
 * which surfaces.test.ts catches by scanning the components.
 */
export const PORTAL_CLIENT_NAMESPACES = [
  "common",
  "portalShell",
  "portalLabels",
  "portalPayment",
  "portalStatement",
  "portalProfile",
  "portalNotifications",
  "portalDocuments",
  "portalApply",
] as const satisfies readonly Namespace[]

export const WEBSITE_CLIENT_NAMESPACES = [
  "common",
  "websiteShell",
  "websiteHome",
  "websiteContact",
  "websiteCalculators",
  "websiteProducts",
  "websiteQualify",
  "websiteApply",
] as const satisfies readonly Namespace[]
