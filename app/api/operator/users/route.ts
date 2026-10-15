import { NextRequest, NextResponse } from "next/server"
import { requireOperatorApi } from "@/lib/operator/console-auth"
import { inviteOperatorUser } from "@/lib/operator/console/operator-users"
import { callerIp } from "@/lib/rate-limit"

// POST { email, name, role }: invite an operator user (OPERATOR_ADMIN, audited).
export async function POST(req: NextRequest) {
  const guard = await requireOperatorApi({ admin: true })
  if (guard.error) return guard.error
  const body: unknown = await req.json().catch(() => null)
  const result = await inviteOperatorUser(guard.principal, body, callerIp(req))
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json(result, { status: 201 })
}
