import { NextRequest, NextResponse } from "next/server"
import { requireOperatorApi } from "@/lib/operator/console-auth"
import { sendOperatorUserReset } from "@/lib/operator/console/operator-users"
import { callerIp } from "@/lib/rate-limit"

// POST: email an operator user a new set-password link (OPERATOR_ADMIN, audited).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOperatorApi({ admin: true })
  if (guard.error) return guard.error
  const { id } = await params
  const result = await sendOperatorUserReset(guard.principal, id, callerIp(req))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result)
}
