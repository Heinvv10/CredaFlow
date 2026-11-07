import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logger } from "@/lib/observability/logger"
import { getWebsiteImageryDocument } from "@/lib/config/website-imagery"
import { PRODUCT_SLUGS } from "@/lib/config/website-imagery-schema"
import { getLivePricingServer } from "@/lib/public-loan-products-server"

/**
 * The website images the lender has set, for the staff form (alt text, community
 * text, file hashes), and the loan products it offers (the home page shows a
 * card for each). ADMIN, like the writes.
 */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const imagery = (await getWebsiteImageryDocument(tenant.id)) ?? {}
      const offered = await getLivePricingServer(tenant.id)
      return NextResponse.json({ imagery, offeredProducts: PRODUCT_SLUGS.filter((slug) => offered[slug]) })
    } catch (e) {
      logger.error("[website-imagery] could not read the website images", { reason: e instanceof Error ? e.message : String(e) })
      return NextResponse.json({ error: "Failed to load the website images" }, { status: 500 })
    }
  })
}
