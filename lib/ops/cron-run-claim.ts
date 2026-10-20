import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"

/**
 * Run claims for the single-run in-process jobs (`singleRun` in
 * lib/registry/define.ts). Every replica schedules every job, so each fires it
 * and calls `claimCronRun` first; only the replica that gets a token calls the
 * route, keeps the claim alive with `renewCronClaim` while the call is in
 * flight, and closes it with `finishCronRun`.
 *
 * One row per (job, SAST day) carries the state:
 *  - no row: the insert wins and the caller runs.
 *  - DONE: nobody runs it again that day.
 *  - FAILED (the HTTP call failed or threw): the next firing takes it over.
 *  - RUNNING: left alone while its runner renews `claimedAt`; taken over only
 *    once that heartbeat is STALE_RUNNING_MINUTES old, i.e. the runner died.
 *
 * Every attempt holds a random `ownerToken`. Renewing and closing match it, so
 * an old runner that is slow or partitioned can neither keep nor mark done an
 * attempt that has been taken over from it.
 *
 * Each single-run job is fired at its time and again 30 and 60 minutes later
 * (`cronOccurrences`), so a lost run costs at most an hour, not the day. A
 * takeover can still overlap a runner that lost only its heartbeat, so the work
 * is also deduped downstream: reminders by LoanNote, sendMessage's idempotency
 * key and `reserveOnce` below; escalations by noteExists and `reserveOnce`.
 */

/** A runner renews every minute; this many without a renewal means it died. */
export const STALE_RUNNING_MINUTES = 5
export const HEARTBEAT_INTERVAL_MS = 60_000
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

/** The attempt's owner token, or null when the job is DONE, running, or claimed elsewhere. */
export async function claimCronRun(job: string, now: Date = new Date()): Promise<string | null> {
  const runDay = sastCalendarDate(now)
  const ownerToken = randomUUID()
  const { count } = await prisma.cronRunClaim.createMany({ data: [{ job, runDay, claimedAt: now, ownerToken }], skipDuplicates: true })
  if (count === 1) return ownerToken
  // One UPDATE: of racing firings only the first passes the condition.
  const staleBefore = new Date(now.getTime() - STALE_RUNNING_MINUTES * 60_000)
  const taken = await prisma.cronRunClaim.updateMany({
    where: { job, runDay, OR: [{ status: "FAILED" }, { status: "RUNNING", claimedAt: { lt: staleBefore } }] },
    data: { status: "RUNNING", claimedAt: now, finishedAt: null, attempts: { increment: 1 }, ownerToken },
  })
  return taken.count === 1 ? ownerToken : null
}

/** Proves the runner is alive. False when the claim is no longer this token's (taken over, or closed). */
export async function renewCronClaim(job: string, ownerToken: string, claimedAt: Date, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.cronRunClaim.updateMany({
    where: { job, runDay: sastCalendarDate(claimedAt), status: "RUNNING", ownerToken },
    data: { claimedAt: now },
  })
  return count === 1
}

/** Closes the claim as DONE or FAILED, only if `ownerToken` still holds it. */
export async function finishCronRun(job: string, ownerToken: string, ok: boolean, claimedAt: Date): Promise<boolean> {
  const { count } = await prisma.cronRunClaim.updateMany({
    where: { job, runDay: sastCalendarDate(claimedAt), status: "RUNNING", ownerToken },
    data: { status: ok ? "DONE" : "FAILED", finishedAt: new Date() },
  })
  return count === 1
}

/**
 * A database-unique reservation for one borrower message (or rule action) per
 * SAST day, taken BEFORE it is sent: of two runs that both passed the
 * "already done today" check only one gets `true`. `release` it if the send
 * failed so a retry can send. Rows are (job, runDay) in CronRunClaim, with
 * `send:` and `escalation:` job prefixes, and are never read as a cron run.
 */
export async function reserveOnce(key: string, now: Date = new Date()): Promise<boolean> {
  const { count } = await prisma.cronRunClaim.createMany({
    data: [{ job: key, runDay: sastCalendarDate(now), claimedAt: now, status: "DONE", finishedAt: now }],
    skipDuplicates: true,
  })
  return count === 1
}

export async function releaseReservation(key: string, now: Date = new Date()): Promise<void> {
  await prisma.cronRunClaim.deleteMany({ where: { job: key, runDay: sastCalendarDate(now) } })
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
