import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"

/**
 * Claims one run of a single-run in-process job (`singleRun` in
 * lib/registry/define.ts) for the SAST day of `now`. Every replica schedules
 * every job, so each calls this first and only the one that gets `true` calls
 * the route. The insert is atomic against the (job, runDay) primary key, so two
 * replicas firing in the same instant, or one firing seconds after the other
 * has finished, still produce one run a day.
 *
 * A claim is never released: if the winner dies mid-run the day's run is lost,
 * and /api/health shows the job stale (lib/ops/cron-heartbeat.ts) rather than
 * a second replica re-sending borrower comms. The route stays callable by hand.
 */
export async function claimCronRun(job: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.cronRunClaim.createMany({
    data: [{ job, runDay: sastCalendarDate(now) }],
    skipDuplicates: true,
  })
  return count === 1
}
