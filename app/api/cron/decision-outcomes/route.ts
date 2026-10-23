import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runDecisionOutcomes } from "@/lib/learning-loop/outcomes/job"
import { FAILED_TENANTS_HEADER } from "@/lib/ops/cron-call"
import { sweepStatus } from "@/lib/ops/tenant-sweep"

/**
 * Nightly decision outcomes (docs/learning-loop/DESIGN.md §4): derives
 * DecisionOutcome rows for every ACTIVE tenant from its servicing tables.
 * Idempotent; sends nothing. A loan whose derivation threw is counted in the
 * body (`failedLoans`) and leaves the run 200: a retry would not fix it. A
 * tenant that threw is in the x-cron-failed-tenants header; the status is 503
 * only when every tenant threw (sweepStatus).
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const asOf = new Date()
  const result = await runDecisionOutcomes(asOf)
  const { status, partial } = sweepStatus({ tenants: result.tenants, failedTenants: result.failedTenants, otherErrors: 0 })
  return NextResponse.json(
    { ok: status === 200, partial, runAt: asOf.toISOString(), ...result },
    { status, headers: { [FAILED_TENANTS_HEADER]: String(result.failedTenants) } },
  )
}
