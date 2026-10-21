import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runArrangementCheck } from "@/lib/collections/arrangement-check"
import { sweepStatus } from "@/lib/ops/tenant-sweep"

/**
 * Nightly evaluation of every ACTIVE tenant's active payment arrangements
 * (lib/collections/arrangement-check.ts). An arrangement whose verdict could not
 * be written is counted in `failed` and turns the response 503: it is a hold that
 * never lifts. A tenant whose pass threw is counted in `failedTenants`; that is
 * 503 only when every tenant failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await runArrangementCheck()
  const { status, partial } = sweepStatus({ tenants: result.tenants, failedTenants: result.failedTenants, otherErrors: result.failed })
  return NextResponse.json({ ok: status === 200, partial, ...result }, { status })
}
