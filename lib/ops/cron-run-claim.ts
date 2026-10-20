import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"

/**
 * Run claims for the single-run in-process jobs (`singleRun` in
 * lib/registry/define.ts). Every replica schedules every job, so each fires it
 * and calls `claimCronRun` first; only the replica that gets `true` calls the
 * route and then records the outcome with `finishCronRun`.
 *
 * One row per (job, SAST day) carries the state:
 *  - no row: the insert wins and the caller runs.
 *  - DONE: nobody runs it again that day.
 *  - FAILED (the HTTP call failed or threw): the next firing takes it over.
 *  - RUNNING and older than STALE_RUNNING_MINUTES: its replica is presumed
 *    dead and the next firing takes it over; a fresh RUNNING is left alone.
 *
 * Each single-run job is therefore fired at its time and again 30 and 60
 * minutes later (`cronOccurrences`), so a lost run costs at most an hour, not
 * the day. The retry is safe because the work is deduped downstream: reminders
 * by LoanNote and idempotencyKey, escalations by noteExists.
 */

/** Well above a normal run, below the 30-minute retry gap. */
export const STALE_RUNNING_MINUTES = 25
export const RETRY_OFFSET_MINUTES = [30, 60] as const

/** The "M H * * *" expression `offset` minutes later the same day. */
function shiftDaily(schedule: string, offset: number): string {
  const match = /^(\d+) (\d+) \* \* \*$/.exec(schedule.trim())
  if (!match) throw new Error(`single-run schedule "${schedule}" must be once a day ("M H * * *")`)
  const total = Number(match[2]) * 60 + Number(match[1]) + offset
  if (total >= 24 * 60) throw new Error(`single-run schedule "${schedule}" has no room for a +${offset} minute retry the same day`)
  return `${total % 60} ${Math.floor(total / 60)} * * *`
}

/**
 * What the scheduler registers, in order: every job at its own time, then the
 * +30 and +60 minute retries of the single-run ones. `attempt` is 0 for a job's
 * own time.
 */
export function cronOccurrences<T extends { schedule: string; singleRun: boolean }>(
  jobs: readonly T[],
): Array<{ job: T; schedule: string; attempt: number }> {
  const own = jobs.map((job) => ({ job, schedule: job.schedule, attempt: 0 }))
  const retries = jobs.filter((job) => job.singleRun).flatMap((job) =>
    RETRY_OFFSET_MINUTES.map((offset, i) => ({ job, schedule: shiftDaily(job.schedule, offset), attempt: i + 1 })),
  )
  return [...own, ...retries]
}

export async function claimCronRun(job: string, now: Date = new Date()): Promise<boolean> {
  const runDay = sastCalendarDate(now)
  const { count } = await prisma.cronRunClaim.createMany({ data: [{ job, runDay, claimedAt: now }], skipDuplicates: true })
  if (count === 1) return true
  // One UPDATE: of racing firings only the first passes the condition.
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MINUTES * 60_000)
  const taken = await prisma.cronRunClaim.updateMany({
    where: { job, runDay, OR: [{ status: "FAILED" }, { status: "RUNNING", claimedAt: { lt: staleBefore } }] },
    data: { status: "RUNNING", claimedAt: now, finishedAt: null, attempts: { increment: 1 } },
  })
  return taken.count === 1
}

export async function finishCronRun(job: string, ok: boolean, now: Date = new Date()): Promise<void> {
  await prisma.cronRunClaim.updateMany({
    where: { job, runDay: sastCalendarDate(now), status: "RUNNING" },
    data: { status: ok ? "DONE" : "FAILED", finishedAt: new Date() },
  })
}

/** Marks `job` DONE for today without a claim, e.g. the per-tenant "dpd-update:<tenantId>". */
export async function recordCronDone(job: string, now: Date = new Date()): Promise<void> {
  const runDay = sastCalendarDate(now)
  await prisma.cronRunClaim.upsert({
    where: { job_runDay: { job, runDay } },
    create: { job, runDay, claimedAt: now, status: "DONE", finishedAt: now },
    update: { status: "DONE", finishedAt: now },
  })
}

export async function cronDoneToday(job: string, now: Date = new Date()): Promise<boolean> {
  const row = await prisma.cronRunClaim.findUnique({ where: { job_runDay: { job, runDay: sastCalendarDate(now) } }, select: { status: true } })
  return row?.status === "DONE"
}
