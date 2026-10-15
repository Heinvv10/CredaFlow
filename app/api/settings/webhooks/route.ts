import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireApiSettingsAdmin } from "@/lib/lender-api/settings-guard"
import { parseWebhookEvents } from "@/lib/lender-api/webhooks/events"
import { createWebhookEndpoint } from "@/lib/lender-api/webhooks/endpoints"

// Add a webhook endpoint. The signing secret is in this response and nowhere else.
export async function POST(req: NextRequest) {
  const guard = await requireApiSettingsAdmin()
  if (guard.error) return guard.error
  const user = guard.user

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { url?: unknown; description?: unknown; events?: unknown } | null
    const url = typeof body?.url === "string" ? body.url.trim() : ""
    if (!url) return NextResponse.json({ error: "Enter the endpoint URL." }, { status: 400 })
    const description = typeof body?.description === "string" && body.description.trim() ? body.description.trim().slice(0, 200) : null
    const events = parseWebhookEvents(body?.events)
    if (!events) return NextResponse.json({ error: "Choose at least one valid event." }, { status: 400 })

    const outcome = await createWebhookEndpoint({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      url,
      description,
      events,
    })
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json(
      { endpoint: outcome.endpoint, secret: outcome.secret },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    )
  })
}
