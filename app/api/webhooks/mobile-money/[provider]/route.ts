import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { findMobileMoneyProvider } from "@/lib/mobile-money/registry"
import { ingestMobileMoneyCallback } from "@/lib/mobile-money/c2b-ingest"

// M-Pesa payment callbacks (paybill C2B confirmations and STK push results).
// Public (lib/public-routes.ts, /api/webhooks/*): the adapter's parseCallback
// verifies the provider's signature and an unverifiable body is refused (401)
// before anything is read from it. The tenant comes from the host, never the
// body. A replayed callback books nothing (lib/mobile-money/book.ts).

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await params
  const provider = findMobileMoneyProvider(providerId)
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 })
  const rawBody = await req.text()
  const callback = provider.parseCallback({ rawBody, headers: req.headers })
  if (!callback) return NextResponse.json({ error: "Unverified callback" }, { status: 401 })
  return withTenantContext(req, async (tenant) => {
    const out = await ingestMobileMoneyCallback(prisma, { tenantId: tenant.id, provider, callback })
    // Accepted even when unmatched or a duplicate, so the provider does not
    // retry forever; `outcome` says what happened.
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted", ...out })
  })
}
