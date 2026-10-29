import { NextRequest, NextResponse } from "next/server"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runReferenceRateFeed } from "@/lib/asset-finance/rate-feed-sync"

/**
 * Reference-rate feed cron: fetches the Reserve Bank's repo, prime and
 * ZARONIA values and records each change as a PENDING reference rate for every
 * asset-finance tenant (lib/asset-finance/rate-feed-sync.ts). A person still
 * approves each value. Idempotent, so any number of runs a day is safe.
 * Answers 503 with the reason when the feed could not be read, or when
 * recording failed for a tenant.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  // The SARB repo rate feeds the NCA interest cap and asset finance: a lender
  // outside the NCA's jurisdiction has no use for it. A 200, so the cron
  // heartbeat does not read the skip as a failure.
  await ensureActiveJurisdiction()
  if (!isNcaJurisdiction()) return NextResponse.json({ skipped: "not applicable to this lender" })

  const run = await runReferenceRateFeed(prisma)
  return NextResponse.json(run, { status: run.ok ? 200 : 503 })
}
