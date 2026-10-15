import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runCollectionsCron } from "@/lib/collections-engine/cron"

/**
 * Collections engine, results side: fetch the provider's outcomes, book paid
 * collections as receipts, note unpaids and apply the scheme stop rules.
 * Only tenants with collectionsEngineEnabled are touched.
 *
 * Any failed tenant makes the response 503: the scheduler treats only a
 * non-2xx as a failure and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  const now = new Date()
  const run = await runCollectionsCron("RESULTS", now)
  return NextResponse.json({ ...run, runAt: now.toISOString() }, { status: run.ok ? 200 : 503 })
}
