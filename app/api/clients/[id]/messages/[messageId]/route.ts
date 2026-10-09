import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { messagePresentationStatus } from "@/lib/messaging/reconciliation"

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string; messageId: string }> }
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: clientId, messageId } = await ctx.params

  return withTenantContext(req, async (tenant) => {
    const client = await prisma.client.findFirst({ where: { id: clientId, tenantId: tenant.id }, include: { contact: true } })
    if (!client || !client.contact) {
      return NextResponse.json({ error: "client has no contact" }, { status: 400 })
    }

    const message = await prisma.message.findFirst({
      where: { id: messageId, tenantId: tenant.id, conversation: { contactId: client.contact.id } },
      select: { status: true, dispatchState: true, dispatchLeaseExpiresAt: true },
    })
    if (!message) {
      return NextResponse.json({ error: "message not found" }, { status: 404 })
    }

    return NextResponse.json({ status: messagePresentationStatus(message) })
  })
}
