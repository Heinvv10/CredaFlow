import { NextRequest, NextResponse } from "next/server"
import { processEscalations } from "@/lib/collections/escalation"
import { verifyCronSecret } from "@/lib/cron-auth"
import { FAILED_TENANTS_HEADER } from "@/lib/ops/cron-call"
import { sweepStatus } from "@/lib/ops/tenant-sweep"

export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await processEscalations()

  // `errors` is a rule that threw while advancing one loan (the DEFAULTED status
  // flip at 60 DPD, the legal flag at 90, the soft-reminder note; see
  // lib/collections/escalation.ts). It is in the body and leaves the response 200:
  // a retry would not fix one loan, and a 503 every day would hide the failure a
  // retry is for, a tenant whose whole run threw (`failedTenants`). The scheduler
  // reads that count from the x-cron-failed-tenants header and marks the run FAILED
  // so the +30 and +60 minute firings retry it (the rules are deduped, so that is
  // safe). The status is 503 only when EVERY tenant threw (sweepStatus), so
  // /api/health, which reads the status, goes red for this job only on a
  // single-tenant deployment or when every tenant fails.
  const { status, partial } = sweepStatus({ tenants: result.tenants, failedTenants: result.failedTenants, otherErrors: 0 })
  return NextResponse.json({ ok: status === 200, partial, ...result }, { status, headers: { [FAILED_TENANTS_HEADER]: String(result.failedTenants) } })
}
