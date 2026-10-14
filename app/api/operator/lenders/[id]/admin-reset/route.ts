import { NextRequest, NextResponse } from "next/server"
import { requireOperatorApi } from "@/lib/operator/console-auth"
import { sendLenderAdminReset } from "@/lib/operator/console/lender-actions"
import { callerIp } from "@/lib/rate-limit"

// POST { userId }: email one of the lender's admins a reset link (OPERATOR_ADMIN, audited).
// The link goes to the admin only; the response never carries it.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOperatorApi({ admin: true })
  if (guard.error) return guard.error
  const { id } = await params
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null
  const result = await sendLenderAdminReset({ principal: guard.principal, tenantId: id, userId: body?.userId, ipAddress: callerIp(req) })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result)
}
