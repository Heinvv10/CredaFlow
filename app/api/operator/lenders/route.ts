import { NextRequest, NextResponse } from "next/server"
import { requireOperatorApi } from "@/lib/operator/console-auth"
import { provisionLender } from "@/lib/operator/console/provision"

// POST: provision a lender (OPERATOR_ADMIN). Validation, creation and audit
// are scripts/lender's (lib/operator/console/provision.ts).
export async function POST(req: NextRequest) {
  const guard = await requireOperatorApi({ admin: true })
  if (guard.error) return guard.error
  const body: unknown = await req.json().catch(() => null)
  const result = await provisionLender(guard.principal, body)
  if (!result.ok) return NextResponse.json({ error: result.error, errors: result.errors }, { status: result.status })
  return NextResponse.json(result, { status: 201 })
}
