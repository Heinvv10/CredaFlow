import type { LenderIdentity } from "@/lib/config/identity-schema"
import type { SiteJurisdiction } from "./site-jurisdiction"

type HomeIdentity = Pick<LenderIdentity, "tradingName" | "ncrNumber">

/**
 * The home page's tab title. Insurance is sold, and the NCR named, only where the
 * NCA applies; elsewhere the page says what it sells and where.
 */
export function homeTitle(site: SiteJurisdiction): string {
  return site.nca ? `Credit and insurance — ${site.countryName}` : `Credit — ${site.countryName}`
}

export function homeDescription(identity: HomeIdentity, site: SiteJurisdiction): string {
  if (!site.nca) return `${identity.tradingName} offers responsible credit for people in ${site.countryName}.`
  return `${identity.tradingName} offers responsible credit and insurance enquiries for South Africans. ${identity.ncrNumber ? `NCR-registered (${identity.ncrNumber}) ` : ""}with POPIA-aware processes.`
}
