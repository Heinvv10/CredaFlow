import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { getCommsSettings } from "@/lib/inbox/settings"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: leadId } = await ctx.params

  return withTenantContext(req, async (tenant) => {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId: tenant.id }, include: { contact: true } })
    if (!lead || !lead.contact) {
      return NextResponse.json({ error: "lead has no contact" }, { status: 400 })
    }

    const settings = await getCommsSettings(tenant.id)
    const availability = await getChannelAvailability({
      tenantId: tenant.id,
      contact: lead.contact,
      whatsappEnabled: settings.whatsappEnabled,
    })

    // Strip toValue — the UI only needs {enabled, reason}.
    const stripped = Object.fromEntries(
      Object.entries(availability).map(([key, v]) => [key, { enabled: v.enabled, reason: v.reason }])
    )

    return NextResponse.json(stripped)
  })
}
