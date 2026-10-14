import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runCollectionsCron } from "@/lib/collections-engine/cron"

/**
 * Collections engine, submit side: refresh mandates with the provider, plan
 * instructions from the loans' schedules, and submit the batches due today.
 * Only tenants with collectionsEngineEnabled are touched.
 *
 * Any failed tenant makes the response 503: the scheduler treats only a
 * non-2xx as a failure and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const now = new Date()
  const run = await runCollectionsCron("SUBMIT", now)
  return NextResponse.json({ ...run, runAt: now.toISOString() }, { status: run.ok ? 200 : 503 })
}
