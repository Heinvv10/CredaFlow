import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyCronSkip } from "@/lib/jurisdiction/nca-only"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sastCalendarDate } from "@/lib/date/sast"
import { runRecoveryDeadlineSweep } from "@/lib/asset-finance/recovery-freeze-deadline"

/**
 * Daily: for each shortfall recovery whose charge freeze has ended, move the
 * loan on toward collections (never backwards, never a write-off), bell the
 * recovery's creator and audit it, once; and bell the creator, once, of each NCA
 * recovery still without its final notice 5 business days after the proceeds
 * (lib/asset-finance/recovery-freeze-deadline.ts). Safe to run any number of
 * times a day. Answers 503 with the counts when any recovery failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  // Asset finance is an NCA product: nothing to do for a lender outside the NCA's jurisdiction.
  const skipped = await ncaOnlyCronSkip()
  if (skipped) return skipped

  const run = await runRecoveryDeadlineSweep(sastCalendarDate(new Date()))
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
