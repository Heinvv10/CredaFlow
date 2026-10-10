import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { processRetryBatch } from "@/lib/messaging/retry"

/**
 * Retry sweep cron.
 *
 * Schedule: every 60 seconds. Driven by an external scheduler (the
 * existing cron infrastructure that hits /api/cron/* endpoints with
 * X-Cron-Secret). NOT tenant-scoped — processes RETRYING rows across all
 * tenants.
 *
 * Limit: 50 rows per sweep. At 60s cadence this caps throughput at
 * ~3000 retries/hour, comfortable for a 1000-client operation. Bump the
 * limit (not the cadence) if we approach that ceiling.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await processRetryBatch({ limit: 50, now: new Date() })

  // manualReconciliation is the row this sweep could NOT resolve on its own —
  // an ambiguous provider outcome, a post-dispatch DB write that never landed,
  // or a claimed dispatch token that could not be finalised. Those need a
  // human to look at the queue. failedPermanent/rescheduled are understood,
  // expected outcomes (a message genuinely can't be retried, or it's on
  // normal backoff) and are not sweep failures. A hardcoded ok:true would hide
  // a sweep that is silently piling up unresolved rows from the systemd
  // wrapper, which only fails the unit on HTTP >= 400 and never parses this
  // body.
  const ok = result.manualReconciliation === 0

  return NextResponse.json(
    {
      ok,
      ranAt: new Date().toISOString(),
      ...result,
    },
    { status: ok ? 200 : 503 },
  )
}
