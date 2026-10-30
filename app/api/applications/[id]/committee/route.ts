import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { CommitteeError, recordCommitteeDecision } from "@/lib/approval/committee"
import { withTenantContext } from "@/lib/tenant"

const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null)

/** Records the credit committee's decision: { decision, meetingDate, attendees, conditions, rationale }. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "record_committee_decision")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const attendees = strings(body?.attendees)
    const conditions = strings(body?.conditions ?? [])
    if (!body || !["APPROVED", "DECLINED", "DEFERRED"].includes(body.decision as string) || typeof body.meetingDate !== "string" || !attendees || !conditions || typeof body.rationale !== "string") {
      return NextResponse.json({ error: "Expected { decision, meetingDate, attendees, conditions, rationale }" }, { status: 400 })
    }
    try {
      const created = await recordCommitteeDecision({
        tenantId: tenant.id, actor: guard.user, applicationId: id,
        decision: { decision: body.decision as "APPROVED" | "DECLINED" | "DEFERRED", meetingDate: body.meetingDate, attendees, conditions, rationale: body.rationale },
      })
      return NextResponse.json({ id: created.id }, { status: 201 })
    } catch (error) {
      if (error instanceof CommitteeError) return NextResponse.json({ error: error.message, code: error.code, problems: error.problems }, { status: error.status })
      throw error
    }
  })
}
