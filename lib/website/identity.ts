import { cache } from "react"
import { findLenderIdentity, type LenderIdentity } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"

/**
 * The lender identity the public website prints, for this request's tenant
 * (lib/tenant.ts resolution), or null while that tenant has not configured
 * it. Never a default: every website page reads this and renders the
 * not-configured state on null. Cached per render, so the layout, the page
 * and its metadata share one read.
 */
export const getWebsiteIdentity = cache(async (): Promise<LenderIdentity | null> =>
  findLenderIdentity(await getResolvedTenantId()),
)
