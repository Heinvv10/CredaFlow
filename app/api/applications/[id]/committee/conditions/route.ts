import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { clearCondition, ConditionError } from "@/lib/approval/conditions"
import { withTenantContext } from "@/lib/tenant"

/** Records a committee condition as met: { index, note }. Answers the list as it now stands. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "clear_committee_conditions")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const body = (await req.json().catch(() => null)) as { index?: unknown; note?: unknown } | null
    if (!Number.isInteger(body?.index) || typeof body?.note !== "string") return NextResponse.json({ error: "Expected { index, note }" }, { status: 400 })
    try {
      return NextResponse.json({ conditions: await clearCondition({ tenantId: tenant.id, actor: guard.user, applicationId: id, index: body.index as number, note: body.note }) })
    } catch (error) {
      if (error instanceof ConditionError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status })
      throw error
    }
  })
}
