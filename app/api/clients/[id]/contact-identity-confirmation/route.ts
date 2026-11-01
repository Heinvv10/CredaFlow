import { NextResponse, type NextRequest } from "next/server"
import type { Channel } from "@prisma/client"
import { requireApiRole } from "@/lib/auth-guards"
import { CONFIRMABLE_CHANNELS, CONFIRMATION_NOTE_MIN, confirmContactIdentity } from "@/lib/contact/identity-confirmation"
import { recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"

type RouteCtx = { params: Promise<{ id: string }> }

/** A staff member other than the one who set it confirms a borrower's email or WhatsApp number, so a signing code may go there. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as { channel?: unknown; note?: unknown } | null
    const note = typeof body?.note === "string" ? body.note.trim() : ""
    if (!CONFIRMABLE_CHANNELS.includes(body?.channel as Channel)) return NextResponse.json({ error: "channel must be EMAIL or WHATSAPP" }, { status: 400 })
    if (note.length < CONFIRMATION_NOTE_MIN) return NextResponse.json({ error: "Say how you know this is the borrower's." }, { status: 400 })
    const result = await confirmContactIdentity({
      tenantId: tenant.id, clientId: id, channel: body?.channel as Channel,
      by: { type: "staff", id: guard.user.id, email: guard.user.email ?? "", note, ipAddress: recordedCallerIp(req) ?? undefined },
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true })
  })
}
