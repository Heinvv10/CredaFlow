import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyCronSkip } from "@/lib/jurisdiction/nca-only"
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
  // Asset finance is an NCA product: nothing to do for a lender outside the NCA's jurisdiction.
  const skipped = await ncaOnlyCronSkip()
  if (skipped) return skipped

  const run = await purgeTelematicsPositions()
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
