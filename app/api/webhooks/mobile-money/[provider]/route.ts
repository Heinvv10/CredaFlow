import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { findMobileMoneyProvider } from "@/lib/mobile-money/registry"
import { ingestMobileMoneyCallback } from "@/lib/mobile-money/c2b-ingest"

// M-Pesa payment callbacks (paybill C2B confirmations and STK push results).
// Public (lib/public-routes.ts, /api/webhooks/*). A request without the
// provider's signature header, or declaring a body above the limit, is refused
// before the body is read. The tenant comes from the host, never the body, and
// is part of what the adapter's parseCallback verifies (a callback signed for
// another lender is refused, 401) before anything is read from the body. A
// replayed callback books nothing (lib/mobile-money/book.ts).

/** Far above any provider callback; bounds what an unauthenticated caller makes us read. */
export const MAX_CALLBACK_BYTES = 16 * 1024

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await params
  const provider = findMobileMoneyProvider(providerId)
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 })
  if (!req.headers.get(provider.signatureHeader)) return NextResponse.json({ error: "Unverified callback" }, { status: 401 })
  if (Number(req.headers.get("content-length") ?? 0) > MAX_CALLBACK_BYTES) {
    return NextResponse.json({ error: "Callback too large" }, { status: 413 })
  }
  return withTenantContext(req, async (tenant) => {
    const rawBody = await req.text()
    if (Buffer.byteLength(rawBody) > MAX_CALLBACK_BYTES) return NextResponse.json({ error: "Callback too large" }, { status: 413 })
    const callback = provider.parseCallback({ rawBody, headers: req.headers, tenantId: tenant.id })
    if (!callback) return NextResponse.json({ error: "Unverified callback" }, { status: 401 })
    const { outcome } = await ingestMobileMoneyCallback(prisma, { tenantId: tenant.id, provider, callback })
    // Accepted even when unmatched or a duplicate, so the provider does not
    // retry forever. No ids: an outcome is all a caller learns.
    return NextResponse.json({ ResultCode: 0, ResultDesc: "Accepted", outcome })
  })
}
