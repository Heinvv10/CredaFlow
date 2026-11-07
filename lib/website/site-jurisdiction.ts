import { profileFor, type Jurisdiction } from "@/lib/jurisdiction/profiles"

/**
 * What the public website needs to know about the lender's jurisdiction. Plain
 * data so a client component can take it from the server (WebsiteIdentity.tsx)
 * instead of reading the process-wide value in the browser.
 */
export interface SiteJurisdiction {
  code: Jurisdiction
  /** Credit here falls under the NCA: its regulator, insurance and legal copy apply. */
  nca: boolean
  countryName: string
}

export function siteJurisdictionFor(code: Jurisdiction): SiteJurisdiction {
  const profile = profileFor(code)
  return { code, nca: profile.ncaRegulated, countryName: profile.countryName }
}

/** The fail-closed default: a South African lender, every NCA statement on. */
export const ZA_SITE: SiteJurisdiction = siteJurisdictionFor("ZA")
