import { activeJurisdiction } from "@/lib/jurisdiction/active"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { siteJurisdictionFor, type SiteJurisdiction } from "./site-jurisdiction"

/**
 * The lender's jurisdiction for a website server component. Loads it first: a
 * page may render before anything else on the request has, and an unloaded
 * process answers ZA (the NCA statements on), never the other way round.
 */
export async function getSiteJurisdiction(): Promise<SiteJurisdiction> {
  await ensureActiveJurisdiction()
  return siteJurisdictionFor(activeJurisdiction())
}
