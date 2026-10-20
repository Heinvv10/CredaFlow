import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runDpdUpdate } from "@/lib/loan/dpd-update"

/**
 * DPD Update Cron — nightly reconcile of daysInArrears + arrearsAmount for the
 * collectible book of every ACTIVE tenant (lib/loan/dpd-update.ts). Scheduled
 * in-process, first of the nightly dunning jobs; this route is also the manual
 * ops trigger. A failed tenant makes the response 503: the scheduler treats
 * only a non-2xx as a failure and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await runDpdUpdate()
  const ok = result.perTenant.every((t) => !("error" in t))
  return NextResponse.json({ ok, ...result, runAt: new Date().toISOString() }, { status: ok ? 200 : 503 })
}
