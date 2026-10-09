import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runBureauCron } from "@/lib/bureau-submission/cron"
import { isDay, previousDay } from "@/lib/bureau-submission/period"

/**
 * Daily bureau file (SACRRA Layout 700v2): registrations and closures of the
 * SAST day before the run, for every tenant with featureBureauSubmission on.
 * `?date=YYYY-MM-DD` re-runs a missed day. No file and no ledger row on a day
 * with nothing to send.
 *
 * Any failed tenant makes the response 503: the scheduler treats only a
 * non-2xx as a failure and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const now = new Date()
  const requested = req.nextUrl.searchParams.get("date")
  if (requested !== null && !isDay(requested)) {
    return NextResponse.json({ ok: false, error: "date must be YYYY-MM-DD" }, { status: 400 })
  }
  const run = await runBureauCron("DAILY", requested ?? previousDay(now), now)
  return NextResponse.json({ ...run, runAt: now.toISOString() }, { status: run.ok ? 200 : 503 })
}
