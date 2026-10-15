import { NextRequest, NextResponse } from "next/server"
import { withTenantContext } from "@/lib/tenant"
import { recordedCallerIp } from "@/lib/rate-limit"
import { requireApiSettingsAdmin } from "@/lib/lender-api/settings-guard"
import { disableWebhookEndpoint } from "@/lib/lender-api/webhooks/endpoints"
import { resumeWebhookEndpoint } from "@/lib/lender-api/webhooks/circuit-breaker"

type Params = { params: Promise<{ id: string }> }

// Resume an endpoint the circuit breaker paused: { "action": "resume" }.
export async function PATCH(req: NextRequest, { params }: Params) {
  const guard = await requireApiSettingsAdmin()
  if (guard.error) return guard.error
  const user = guard.user
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { action?: unknown } | null
    if (body?.action !== "resume") return NextResponse.json({ error: "Unknown action" }, { status: 400 })
    const result = await resumeWebhookEndpoint({
      tenantId: tenant.id,
      endpointId: id,
      actor: { id: user.id, email: user.email, ipAddress: recordedCallerIp(req) ?? undefined },
    })
    if (result === "not_found") return NextResponse.json({ error: "Webhook endpoint not found" }, { status: 404 })
    return NextResponse.json({ ok: true, wasPaused: result === "resumed" })
  })
}

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
