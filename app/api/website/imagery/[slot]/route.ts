import { NextRequest, NextResponse } from "next/server"
import { getTenantFromRequest } from "@/lib/tenant"
import { readWebsiteImage } from "@/lib/config/website-imagery"
import { LARGEST_VARIANT, isVariantWidth } from "@/lib/config/website-imagery-variants"
import { parseSlot } from "@/lib/config/website-imagery-schema"

export const dynamic = "force-dynamic"

type Ctx = { params: Promise<{ slot: string }> }

/**
 * One of the lender's website photos (hero, community, product-<code>), as a
 * WebP copy 800 or 1920 px wide (`?w=`, default 1920): public, like the site
 * that shows it, under the /api/website/* prefix proxy.ts serves to anonymous
 * visitors. Tenant from the request host, never from the caller. Never the
 * uploaded file itself, which keeps its metadata. Cached for a day, so a photo
 * the lender removes is gone from browsers and CDNs by tomorrow (`?v=` only
 * busts the cache for a new upload).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const slot = parseSlot((await ctx.params).slot)
  const asked = req.nextUrl.searchParams.get("w")
  const width = asked === null ? LARGEST_VARIANT : Number(asked)
  if (!slot || !isVariantWidth(width)) return NextResponse.json({ error: "No image is set." }, { status: 404 })
  const tenant = await getTenantFromRequest(req)
  const image = tenant ? await readWebsiteImage(tenant.id, slot, { width }) : undefined
  if (!image) return NextResponse.json({ error: "No image is set." }, { status: 404 })
  return new Response(Buffer.from(image.bytes), {
    headers: {
      "content-type": image.mime,
      "cache-control": "public, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  })
}
