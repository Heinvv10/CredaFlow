import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyCronSkip } from "@/lib/jurisdiction/nca-only"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runTelematicsPoll } from "@/lib/telematics/poll"

/**
 * Every 15 minutes: polls every ACTIVE tracker device of each asset-finance
 * tenant through its provider and ingests the events, idempotently per
 * provider event id (lib/telematics/poll.ts). Sends nothing. Answers 503 with
 * the counts when any provider call or event failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  // Asset finance is an NCA product: nothing to do for a lender outside the NCA's jurisdiction.
  const skipped = await ncaOnlyCronSkip()
  if (skipped) return skipped

  const run = await runTelematicsPoll(new Date())
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
