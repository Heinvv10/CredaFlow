import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyCronSkip } from "@/lib/jurisdiction/nca-only"
import { verifyCronSecret } from "@/lib/cron-auth"
import { purgeDealerDrafts } from "@/lib/dealer/draft-purge"

/**
 * Daily: erases the dealer-captured people, business and documents of dealer
 * deals past their retention, keeping a tombstone (lib/dealer/draft-purge.ts,
 * POPIA). Idempotent. Answers 503 with the counts when any deal or tenant failed.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  // Asset finance is an NCA product: nothing to do for a lender outside the NCA's jurisdiction.
  const skipped = await ncaOnlyCronSkip()
  if (skipped) return skipped

  const run = await purgeDealerDrafts()
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
