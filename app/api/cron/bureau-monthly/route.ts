import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runBureauCron } from "@/lib/bureau-submission/cron"
import { isDay, previousMonthEnd } from "@/lib/bureau-submission/period"

/**
 * Monthly bureau file (SACRRA Layout 700v2) for the month just ended, for
 * every tenant with featureBureauSubmission on. `?period=YYYY-MM-DD` (a month
 * end) re-runs a period; in LIVE mode that creates the next sequence.
 *
 * Schedule it early on the 1st. A loan with a receipt, reversal, closure or
 * write-off dated after the period is held back (POST_PERIOD_ACTIVITY),
 * because the as-at helpers cannot rebuild a past month-end position, so the
 * later it runs the more of the book it holds. Default charges posted after
 * the period do not hold a loan.
 *
 * Any failed tenant makes the response 503: the scheduler treats only a
 * non-2xx as a failure and never reads the body.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const now = new Date()
  const requested = req.nextUrl.searchParams.get("period")
  if (requested !== null && !isDay(requested)) {
    return NextResponse.json({ ok: false, error: "period must be YYYY-MM-DD" }, { status: 400 })
  }
  const run = await runBureauCron("MONTHLY", requested ?? previousMonthEnd(now), now)
  return NextResponse.json({ ...run, runAt: now.toISOString() }, { status: run.ok ? 200 : 503 })
}
