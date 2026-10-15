import { NextRequest, NextResponse } from "next/server"
import { requireOperatorApi } from "@/lib/operator/console-auth"
import { setLenderStatus } from "@/lib/operator/console/lender-actions"
import { callerIp } from "@/lib/rate-limit"

// POST { status: "SUSPENDED" | "ACTIVE", reason }: suspend or reactivate a lender (OPERATOR_ADMIN, audited).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOperatorApi({ admin: true })
  if (guard.error) return guard.error
  const { id } = await params
  const body = (await req.json().catch(() => null)) as { status?: unknown; reason?: unknown } | null
  const result = await setLenderStatus({
    principal: guard.principal, tenantId: id, status: body?.status, reason: body?.reason, ipAddress: callerIp(req),
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result)
}
