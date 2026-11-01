import { NextResponse, type NextRequest } from "next/server"
import type { Channel } from "@prisma/client"
import { auth } from "@/lib/auth"
import { CONFIRMABLE_CHANNELS, confirmContactIdentity } from "@/lib/contact/identity-confirmation"
import { recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"

/** The borrower, in their own session, confirms an email or WhatsApp number staff set on their record. */
export async function POST(req: NextRequest) {
  const session = await auth()
  if (!session?.user?.id || session.user.role !== "CLIENT") return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const clientId = session.user.id
  const body = await req.json().catch(() => null) as { channel?: unknown } | null
  if (!CONFIRMABLE_CHANNELS.includes(body?.channel as Channel)) return NextResponse.json({ error: "channel must be EMAIL or WHATSAPP" }, { status: 400 })
  return withTenantContext(req, async (tenant) => {
    if (session.user.tenantId !== tenant.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const result = await confirmContactIdentity({
      tenantId: tenant.id, clientId, channel: body?.channel as Channel,
      by: { type: "client", clientId, email: session.user.email ?? null, ipAddress: recordedCallerIp(req) ?? undefined },
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true })
  })
}
