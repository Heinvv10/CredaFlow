import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { getWebsiteImageryDocument } from "@/lib/config/website-imagery"

/** The website images the lender has set, for the staff form (alt text, community text, file hashes). ADMIN, like the writes. */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      return NextResponse.json({ imagery: (await getWebsiteImageryDocument(tenant.id)) ?? {} })
    } catch (e) {
      console.error("Failed to read the website images:", e)
      return NextResponse.json({ error: "Failed to load the website images" }, { status: 500 })
    }
  })
}
