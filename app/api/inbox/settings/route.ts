import { NextRequest, NextResponse } from "next/server"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { getCommsSettings, INVALID_CHAT_ALERT_EMAIL, updateCommsSettings, type CommsSettingsPatch } from "@/lib/inbox/settings"
import { logAudit } from "@/lib/audit"

export async function GET(req: NextRequest) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => NextResponse.json(await getCommsSettings(tenant.id)))
}

export async function PUT(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const patch = (await req.json()) as CommsSettingsPatch
  return withTenantContext(req, async (tenant) => {
    try {
      const before = await getCommsSettings(tenant.id)
      const updated = await updateCommsSettings(tenant.id, patch)
      const oldValue = Object.fromEntries(
        Object.keys(patch).map((key) => [key, (before as Record<string, unknown>)[key]]),
      )
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: "COMMS_SETTINGS_UPDATED", entity: "CommsSettings", entityId: updated.id,
        oldValue, newValue: patch as Record<string, unknown>,
      })
      return NextResponse.json(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid settings"
      // Named per field so the settings page can say what is wrong next to the input.
      const errors = message === INVALID_CHAT_ALERT_EMAIL ? { chatAlertEmail: "Enter a valid email address." } : undefined
      return NextResponse.json({ error: message, errors }, { status: 400 })
    }
  })
}
