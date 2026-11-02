import { NextResponse, type NextRequest } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { CONFIRMATION_NOTE_MIN, confirmContactIdentity } from "@/lib/contact/identity-confirmation"
import { recordedCallerIp } from "@/lib/rate-limit"
import { withTenantContext } from "@/lib/tenant"

type RouteCtx = { params: Promise<{ id: string }> }

/** A staff member other than the one who set it confirms the address they reviewed, by its id, so a signing code or a login recovery may go there. */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = await req.json().catch(() => null) as { identityId?: unknown; note?: unknown } | null
    const note = typeof body?.note === "string" ? body.note.trim() : ""
    if (typeof body?.identityId !== "string" || !body.identityId) return NextResponse.json({ error: "identityId names the address you reviewed." }, { status: 400 })
    if (note.length < CONFIRMATION_NOTE_MIN) return NextResponse.json({ error: "Say how you know this is the borrower's." }, { status: 400 })
    const result = await confirmContactIdentity({
      tenantId: tenant.id, clientId: id, identityId: body.identityId,
      by: { id: guard.user.id, email: guard.user.email ?? "", note, ipAddress: recordedCallerIp(req) ?? undefined },
    })
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ok: true })
  })
}
