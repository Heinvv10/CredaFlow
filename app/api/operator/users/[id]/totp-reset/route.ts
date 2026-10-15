import { NextRequest, NextResponse } from "next/server"
import { requireOperatorApi } from "@/lib/operator/console-auth"
import { resetOperatorUserTotp } from "@/lib/operator/console/operator-users"
import { callerIp } from "@/lib/rate-limit"

// POST: clear another operator user's 2FA so they enrol again at their next
// sign-in, and end their sessions (OPERATOR_ADMIN, audited).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireOperatorApi({ admin: true })
  if (guard.error) return guard.error
  const { id } = await params
  const result = await resetOperatorUserTotp(guard.principal, id, callerIp(req))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result)
}
