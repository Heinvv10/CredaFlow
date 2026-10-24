import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runDecisionRecordRetention } from "@/lib/learning-loop/retention/job"
import { FAILED_TENANTS_HEADER } from "@/lib/ops/cron-call"
import { sweepStatus } from "@/lib/ops/tenant-sweep"

/**
 * Nightly credit decision log retention (docs/learning-loop/DESIGN.md §2.7):
 * pseudonymises each ACTIVE tenant's records older than its retention period.
 * A tenant with no period set is untouched. Idempotent; sends nothing. A tenant
 * that threw is in the x-cron-failed-tenants header; the status is 503 only
 * when every tenant threw (sweepStatus).
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const asOf = new Date()
  const result = await runDecisionRecordRetention()
  const { status, partial } = sweepStatus({ tenants: result.tenants, failedTenants: result.failedTenants, otherErrors: 0 })
  return NextResponse.json(
    { ok: status === 200, partial, runAt: asOf.toISOString(), ...result },
    { status, headers: { [FAILED_TENANTS_HEADER]: String(result.failedTenants) } },
  )
}
