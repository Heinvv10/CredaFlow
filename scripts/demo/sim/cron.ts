/**
 * Runs a simulated day's /api/cron/* jobs, in the order and at the SAST time
 * of day production runs them, moving the fake clock to each job's slot.
 *
 * The sim app's own node-cron registry (instrumentation.ts) cannot reach
 * itself (NEXTAUTH_URL is the host port), so nothing runs unless this does —
 * which keeps every cron run ordered against the scenario's own actions.
 *
 * Auth: lib/cron-auth.ts compares the `x-cron-secret` header to CRON_SECRET
 * (timing-safe). /api/cron/* is on the proxy's public-operational allowlist.
 *
 * Times come from instrumentation.ts where it schedules the job. The systemd
 * timers (dpd-update, escalations, reminders, lead-task-reminders,
 * messaging-retry, cleanup-notifications) live on a deploy host, not in the
 * repo, so their slots here are chosen to respect data dependencies:
 * charges and DPD settle before escalations and reminders read them.
 */
import { parseJsonBody } from "./api"
import { now, setClock } from "./clock"
import { log, simBaseUrl, simEnv } from "./env"

type Cadence = "daily" | "sunday" | "first-of-month"

export interface CronJob {
  name: string
  method: "GET" | "POST"
  /** SAST wall-clock time, HH:MM. */
  at: string
  cadence: Cadence
  /** Built and callable, but production schedules it nowhere. */
  unscheduledInProd?: boolean
}

export const CRON_JOBS: readonly CronJob[] = [
  { name: "default-charges", method: "GET", at: "01:30", cadence: "daily" },
  { name: "dpd-update", method: "GET", at: "02:00", cadence: "daily" },
  { name: "escalations", method: "GET", at: "02:30", cadence: "daily" },
  { name: "cross-sell", method: "POST", at: "03:00", cadence: "sunday" },
  { name: "dormant-clients", method: "POST", at: "04:00", cadence: "sunday" },
  { name: "bureau-daily", method: "GET", at: "04:30", cadence: "daily", unscheduledInProd: true },
  { name: "bureau-monthly", method: "GET", at: "04:45", cadence: "first-of-month", unscheduledInProd: true },
  { name: "licence-expiry", method: "GET", at: "05:15", cadence: "daily" },
  { name: "arrangement-check", method: "GET", at: "06:00", cadence: "daily" },
  { name: "insurance-renewal", method: "POST", at: "06:00", cadence: "daily" },
  { name: "reminders", method: "GET", at: "07:00", cadence: "daily" },
  { name: "stale-leads-alert", method: "GET", at: "08:30", cadence: "daily" },
  { name: "lead-task-reminders", method: "GET", at: "09:00", cadence: "daily" },
  { name: "messaging-retry", method: "GET", at: "09:05", cadence: "daily" },
  { name: "website-chat-close", method: "GET", at: "23:20", cadence: "daily" },
  { name: "website-chat-handoffs", method: "GET", at: "23:21", cadence: "daily" },
  { name: "cleanup-notifications", method: "GET", at: "23:30", cadence: "daily" },
]

/** Routes under app/api/cron/ the simulator never calls, and why. */
export const SKIPPED_CRONS: Readonly<Record<string, string>> = {
  "email-poll": "polls a live IMAP mailbox; the sim has no inbound email",
  "check-wa-bridge-status": "polls the WhatsApp bridge; WA_ENABLED=false in the sim",
  "poll-wa-templates": "polls Meta's WABA template API; no WhatsApp account in the sim",
  "automation-engine": "on-demand from Settings → Automation; production has no schedule for it",
  "cleanup-disclosures": "file housekeeping production does not schedule; no effect on demo data",
  "payment-reminders": "duplicate of `reminders` (instrumentation.cron-census.test.ts); running both doubles every reminder",
}

export interface CronRun {
  name: string
  status: number
  at: string
  body: unknown
}

export interface RunCronsOptions {
  /** Also run jobs production does not schedule (the bureau files). */
  includeUnscheduledInProd?: boolean
}

const SAST_OFFSET = "+02:00" // South Africa observes no DST.

function isDue(job: CronJob, day: string): boolean {
  const date = new Date(`${day}T00:00:00Z`)
  if (job.cadence === "sunday") return date.getUTCDay() === 0
  if (job.cadence === "first-of-month") return date.getUTCDate() === 1
  return true
}

/** The jobs due on `day` (YYYY-MM-DD, SAST calendar day), in slot order. */
export function dueCronJobs(day: string, opts: RunCronsOptions = {}): CronJob[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error(`dueCronJobs: "${day}" is not YYYY-MM-DD`)
  return CRON_JOBS.filter((j) => isDue(j, day) && (opts.includeUnscheduledInProd || !j.unscheduledInProd))
}

/** Calls one job at the CURRENT clock; the caller has moved the clock to its slot. */
export async function runCronJob(job: CronJob): Promise<CronRun> {
  const res = await fetch(`${simBaseUrl()}/api/cron/${job.name}`, {
    method: job.method,
    headers: { "x-cron-secret": simEnv("CRON_SECRET") },
    cache: "no-store",
  })
  const text = await res.text()
  let body: unknown = text
  if ((res.headers.get("content-type") ?? "").includes("application/json") && text) {
    body = parseJsonBody(job.method, `/api/cron/${job.name}`, res.status, text)
  }
  log(`cron ${job.name} ${res.status}`)
  return { name: job.name, status: res.status, at: now().toISOString(), body }
}

/**
 * Runs every job due on `day` (YYYY-MM-DD, SAST calendar day). The clock must
 * not yet be past the day's first slot: a cron is never run in the past.
 * Throws after the whole day has run if any job answered non-2xx.
 */
export async function runCronsForDay(day: string, opts: RunCronsOptions = {}): Promise<CronRun[]> {
  const runs: CronRun[] = []

  for (const job of dueCronJobs(day, opts)) {
    const slot = new Date(`${day}T${job.at}:00${SAST_OFFSET}`)
    const current = now()
    if (current.getTime() > slot.getTime() + 60_000) {
      throw new Error(`runCronsForDay(${day}): clock is ${current.toISOString()}, past ${job.name}'s ${job.at} SAST slot`)
    }
    if (current.getTime() < slot.getTime()) await setClock(slot)
    runs.push(await runCronJob(job))
  }

  for (const [name, reason] of Object.entries(SKIPPED_CRONS)) log(`cron ${name} skipped: ${reason}`)

  const failed = runs.filter((r) => r.status < 200 || r.status >= 300)
  if (failed.length > 0) {
    const detail = failed.map((r) => `${r.name} ${r.status} ${JSON.stringify(r.body).slice(0, 500)}`).join("; ")
    throw new Error(`runCronsForDay(${day}): ${failed.length} cron(s) failed: ${detail}`)
  }
  return runs
}
