import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import { findPayoutProvider } from "@/lib/payouts/registry"
import { ingestNotification } from "@/lib/payouts/resolve"

// Payout results from a provider. Public (lib/public-routes.ts): the adapter's
// parseWebhook verifies the provider's signature and an unverifiable body is
// refused before anything is read from it. The tenant comes from the host.
// A notification only ever moves a payout forward along the state machine;
// a repeat or a stale one changes nothing.

export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: providerId } = await params
  const provider = findPayoutProvider(providerId)
  if (!provider?.capabilities.webhooks || !provider.parseWebhook) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 })
  }
  const rawBody = await req.text()
  const notification = provider.parseWebhook({ rawBody, headers: req.headers })
  if (!notification) return NextResponse.json({ error: "Unverified notification" }, { status: 401 })
  return withTenantContext(req, async (tenant) => {
    const out = await ingestNotification(prisma, { tenantId: tenant.id, providerId: provider.id, notification })
    // 200 even when unmatched, so a provider does not retry forever; the
    // body says what happened.
    return NextResponse.json(out)
  })
}
