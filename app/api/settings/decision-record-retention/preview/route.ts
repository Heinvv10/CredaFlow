import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { RETENTION_MONTHS_MAX, RETENTION_MONTHS_MIN, isRetentionMonths } from "@/lib/learning-loop/retention/policy"
import { countDecisionRecordsAgedBy } from "@/lib/learning-loop/retention/preview"

// Read-only: how many of this lender's decision records a retention period would
// pseudonymise at the next nightly run, so the SUPER_ADMIN confirms an
// irreversible change knowing its size. Changes and audits nothing.
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as { months?: unknown } | null
    if (body === null || typeof body !== "object" || !isRetentionMonths(body.months)) {
      return NextResponse.json(
        { error: `months must be a whole number from ${RETENTION_MONTHS_MIN} to ${RETENTION_MONTHS_MAX}.` },
        { status: 400 },
      )
    }
    return NextResponse.json({ ok: true, months: body.months, wouldPseudonymise: await countDecisionRecordsAgedBy(tenant.id, body.months) })
  })
}
