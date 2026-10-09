import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { getCommsSettings, updateCommsSettings, type CommsSettingsPatch } from "@/lib/inbox/settings"
import { logAudit } from "@/lib/audit"

/**
 * Select the per-tenant WhatsApp provider and store official Cloud API (WABA)
 * credentials. ADMIN-guarded — the same floor as the sibling comms-settings
 * mutation (app/api/inbox/settings PUT), because the payload carries an access
 * token and app secret. The response NEVER echoes credential values; only the
 * resolved provider is returned so callers can confirm the selection.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const body = (await req.json().catch(() => null)) as CommsSettingsPatch | null
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid body" }, { status: 400 })
  }
  return withTenantContext(req, async (tenant) => {
    try {
      // The alert address is not a secret: its change is audited by value, as PUT /api/inbox/settings does.
      const before = "chatAlertEmail" in body ? await getCommsSettings(tenant.id) : null
      const updated = await updateCommsSettings(tenant.id, body)
      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "COMMS_SETTINGS_UPDATED",
        entity: "CommsSettings",
        entityId: updated.id,
        // Record WHICH keys changed, never their secret values.
        oldValue: before ? { chatAlertEmail: before.chatAlertEmail } : undefined,
        newValue: { updatedFields: Object.keys(body), waProvider: updated.waProvider, ...(before ? { chatAlertEmail: updated.chatAlertEmail } : {}) },
      })
      return NextResponse.json({ ok: true, waProvider: updated.waProvider })
    } catch (err) {
      const message = err instanceof Error ? err.message : "invalid settings"
      return NextResponse.json({ error: message }, { status: 400 })
    }
  })
}

/** Disconnect WhatsApp Cloud for the tenant: revert to the bridge provider and
 * clear all stored WABA credentials. ADMIN-guarded. */
export async function DELETE(req: NextRequest): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const updated = await updateCommsSettings(tenant.id, {
      waProvider: "WA_UNOFFICIAL",
      wabaId: null,
      wabaPhoneNumberId: null,
      wabaAccessToken: null,
      wabaAppSecret: null,
      wabaBusinessId: null,
      wabaVerifyToken: null,
    })
    await logAudit({
      tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
      action: "COMMS_SETTINGS_UPDATED", entity: "CommsSettings", entityId: updated.id,
      newValue: { disconnected: true, waProvider: "WA_UNOFFICIAL" },
    })
    return NextResponse.json({ ok: true, waProvider: updated.waProvider })
  })
}
