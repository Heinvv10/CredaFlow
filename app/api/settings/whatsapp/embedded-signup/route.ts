import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { updateCommsSettings } from "@/lib/inbox/settings"
import { exchangeCodeForToken, subscribeAppToWaba } from "@/lib/whatsapp/embedded-signup"
import { logAudit } from "@/lib/audit"

/**
 * Completes Meta Embedded Signup for the current tenant: exchanges the popup's
 * auth code for a business token, subscribes our Tech-Provider app to the
 * tenant's WABA webhooks, and stores per-tenant creds (token sealed by
 * updateCommsSettings — requires WABA_ENC_KEY at runtime). ADMIN-guarded;
 * never echoes the token in the response or audit log.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const body = (await req.json().catch(() => null)) as
    | { code?: string; wabaId?: string; phoneNumberId?: string }
    | null
  if (!body?.code || !body.wabaId || !body.phoneNumberId) {
    return NextResponse.json({ error: "code, wabaId and phoneNumberId are required" }, { status: 400 })
  }
  return withTenantContext(req, async (tenant) => {
    try {
      const token = await exchangeCodeForToken(body.code!)
      await subscribeAppToWaba(body.wabaId!, token)
      const updated = await updateCommsSettings(tenant.id, {
        waProvider: "WA_CLOUD",
        wabaId: body.wabaId!,
        wabaPhoneNumberId: body.phoneNumberId!,
        wabaAccessToken: token,
      })
      await logAudit({
        tenantId: tenant.id, userId: guard.user.id, userEmail: guard.user.email,
        action: "COMMS_SETTINGS_UPDATED", entity: "CommsSettings", entityId: updated.id,
        newValue: { embeddedSignup: true, wabaId: body.wabaId, phoneNumberId: body.phoneNumberId },
      })
      return NextResponse.json({ ok: true, connected: true, phoneNumberId: body.phoneNumberId })
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return NextResponse.json(
          { error: "This WhatsApp number is already connected to another tenant" },
          { status: 409 },
        )
      }
      const message = err instanceof Error ? err.message : "embedded signup failed"
      return NextResponse.json({ error: message }, { status: 502 })
    }
  })
}
