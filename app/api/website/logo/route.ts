import { NextRequest, NextResponse } from "next/server"
import { getTenantFromRequest } from "@/lib/tenant"
import { getLenderLogo } from "@/lib/config/lender-logo"

export const dynamic = "force-dynamic"

/**
 * The lender's logo for the public website header and the client portal
 * sidebar: public, like the site that shows it, under the /api/website/*
 * prefix proxy.ts serves to anonymous visitors on both hosts. Same bytes and
 * headers as the staff shell's /api/settings/identity/logo, which stays
 * staff-only; tenant from the request host, never from the caller.
 */
export async function GET(req: NextRequest) {
  const tenant = await getTenantFromRequest(req)
  const bytes = tenant ? await getLenderLogo(tenant.id) : undefined
  if (!bytes) return NextResponse.json({ error: "No logo is set." }, { status: 404 })
  return new Response(Buffer.from(bytes), {
    headers: {
      "content-type": "image/png",
      "cache-control": "public, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  })
}
