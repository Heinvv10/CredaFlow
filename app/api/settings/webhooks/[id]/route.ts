import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireApiSettingsAdmin } from "@/lib/lender-api/settings-guard"
import { disableWebhookEndpoint } from "@/lib/lender-api/webhooks/endpoints"

type Params = { params: Promise<{ id: string }> }

// Disable a webhook endpoint. Its pending deliveries fail on their next attempt.
export async function DELETE(req: NextRequest, { params }: Params) {
  const guard = await requireApiSettingsAdmin()
  if (guard.error) return guard.error
  const user = guard.user
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const result = await disableWebhookEndpoint({
      tenantId: tenant.id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
      endpointId: id,
    })
    if (result === "not_found") return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 })
    return NextResponse.json({ ok: true, alreadyDisabled: result === "already_disabled" })
  })
}
