import { NextResponse } from "next/server"
import { getLenderBrandName } from "@/lib/config/identity"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { lookupContactByChannelValue, toWaJid } from "@/lib/contact/identity"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"
import { getCommsSettings } from "@/lib/inbox/settings"
import { sendWhatsAppForTenant } from "@/lib/whatsapp/send-for-tenant"

/**
 * "Test Connection" on Settings -> WhatsApp.
 *
 * Three things were wrong with this route, and they compounded:
 *
 * 1. It called the Baileys bridge unconditionally, so after the WA_CLOUD
 *    cutover an admin got `WA Sender 503: bridge not connected to WhatsApp` —
 *    a report that WhatsApp is broken, produced by probing a transport the
 *    tenant no longer uses while the live provider was fine.
 * 2. It resolved the tenant from `getDefaultTenantId()`, i.e. the build-baked
 *    NEXT_PUBLIC_TENANT_SLUG, discarding the authenticated caller's own
 *    tenantId. On a second tenant that means sending with another tenant's
 *    WABA credentials.
 * 3. It sent with no contact, so on WA_CLOUD `readWaWindow` saw a null 24h
 *    window and the send failed with WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE *before
 *    any HTTP request to Meta* — for every number, always.
 *
 * What it does now: resolves the caller's tenant from the session, finds the
 * Contact behind the number so the service window is real, checks the same
 * consent gate every other send path uses, and only then sends via the
 * tenant's configured provider.
 *
 * On WA_CLOUD this is a genuine free-form send, so it only succeeds inside
 * Meta's 24h service window — i.e. the recipient must have messaged us
 * recently. That is a true property of the channel, not a fault, and the
 * failure says so rather than being flattened into "Failed to send".
 *
 * A diagnostic must not be a way around consent: `sendWhatsAppForTenant`
 * checks only the ENV kill-switch (WA_ENABLED), which says nothing about
 * do-not-contact, a revoked SERVICE_COMMS consent, or the tenant's own
 * `whatsappEnabled` column.
 */
export async function POST(req: Request) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  const tenantId = guard.user.tenantId

  let phone: unknown
  try {
    phone = ((await req.json()) as { phone?: unknown }).phone
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (typeof phone !== "string" || !phone.trim()) {
    return NextResponse.json({ error: "phone required" }, { status: 422 })
  }

  try {
    const waJid = toWaJid(phone)
    const contact = waJid
      ? await lookupContactByChannelValue(prisma, { tenantId, channel: "WHATSAPP", value: waJid })
      : null

    if (!contact) {
      // Not pedantry: without a Contact there is no window to read, so the
      // send would fail as out-of-window anyway. Saying that is more useful
      // than relaying a provider error code for a lookup we never did.
      return NextResponse.json(
        {
          error:
            "That number has no contact record, so there is no 24h service window to send into. " +
            "Test with a number that has messaged this WhatsApp line.",
        },
        { status: 422 },
      )
    }

    const settings = await getCommsSettings(tenantId)
    const availability = await getChannelAvailability({
      tenantId,
      contact,
      whatsappEnabled: settings.whatsappEnabled,
    })
    if (!availability.WHATSAPP.enabled) {
      return NextResponse.json(
        { error: availability.WHATSAPP.reason ?? "WhatsApp is not available for this contact" },
        { status: 422 },
      )
    }

    const result = await sendWhatsAppForTenant({
      tenantId,
      to: availability.WHATSAPP.toValue ?? phone,
      contactId: contact.id,
      message: `✅ WhatsApp test message from ${await getLenderBrandName(tenantId)}. If you received this, WA integration is working!`,
    })

    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? "Failed to send" }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      messageId: result.messageId,
      simulated: result.simulated === true,
    })
  } catch (err) {
    // Logged rather than swallowed: this route's whole purpose is telling an
    // admin what is wrong, so an unexplained "Test failed" is the failure it
    // exists to prevent.
    console.error("[settings/whatsapp/test] failed:", err)
    return NextResponse.json({ error: "Test failed" }, { status: 500 })
  }
}
