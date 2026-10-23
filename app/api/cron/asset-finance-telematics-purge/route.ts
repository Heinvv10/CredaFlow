import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { purgeTelematicsPositions } from "@/lib/telematics/purge"

/**
 * Nightly: deletes tracker positions (and heartbeat, ignition and position
 * events) older than each tenant's retention (lib/telematics/purge.ts,
 * POPIA). Idempotent. Answers 503 with the counts when any tenant failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const run = await purgeTelematicsPositions()
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
