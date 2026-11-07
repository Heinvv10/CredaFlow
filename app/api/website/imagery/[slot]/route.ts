import { NextRequest, NextResponse } from "next/server"
import { getTenantFromRequest } from "@/lib/tenant"
import { readWebsiteImage } from "@/lib/config/website-imagery"
import { parseSlot } from "@/lib/config/website-imagery-schema"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ slot: string }> }

/**
 * One of the lender's website photos (hero, community, product-<code>): public,
 * like the site that shows it, under the /api/website/* prefix proxy.ts serves
 * to anonymous visitors. Tenant from the request host, never from the caller.
 * The page asks for `?v=<first 12 hex of the file's sha256>`; a request that
 * names the current version may be cached for good, any other for five minutes.
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const slot = parseSlot((await ctx.params).slot)
  const tenant = slot ? await getTenantFromRequest(req) : null
  const image = slot && tenant ? await readWebsiteImage(tenant.id, slot) : undefined
  if (!image) return NextResponse.json({ error: "No image is set." }, { status: 404 })
  const current = req.nextUrl.searchParams.get("v") === image.sha256.slice(0, 12)
  return new Response(Buffer.from(image.bytes), {
    headers: {
      "content-type": image.mime,
      "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  })
}
