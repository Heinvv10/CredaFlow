import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runDpdUpdate } from "@/lib/loan/dpd-update"
import { sweepStatus } from "@/lib/collections/tenant-sweep"

/**
 * DPD Update Cron — nightly reconcile of daysInArrears + arrearsAmount for the
 * collectible book of every ACTIVE tenant (lib/loan/dpd-update.ts). Scheduled
 * in-process, first of the nightly dunning jobs; this route is also the manual
 * ops trigger. A failed tenant is named in `perTenant` and `failedTenants`; the
 * response is 503 only when every tenant failed (sweepStatus): the scheduler
 * treats only a non-2xx as a failure and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await runDpdUpdate()
  const { status, partial } = sweepStatus({ tenants: result.perTenant.length, failedTenants: result.failedTenants, otherErrors: 0 })
  return NextResponse.json({ ok: status === 200, partial, ...result, runAt: new Date().toISOString() }, { status })
}
