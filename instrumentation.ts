export async function register() {
  // Only run scheduler in Node.js runtime (not edge), and only in a server context
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Observability first, so the boot lines below are already structured and
    // traced. Each is off unless its env is set (lib/observability/).
    const { installJsonConsole } = await import("@/lib/observability/json-console")
    installJsonConsole(process.env)
    const { startTracing } = await import("@/lib/observability/tracing")
    try {
      await startTracing(process.env)
    } catch (err) {
      // A tracing misconfiguration must not stop the application booting.
      console.error("[tracing] OpenTelemetry did not start; continuing without traces:", err)
    }
    if (process.env.METRICS_TOKEN?.trim()) {
      const { instrumentHttpServer } = await import("@/lib/observability/http-metrics")
      instrumentHttpServer()
    }

    const { assertSmileIdentityRuntimeSafety } = await import("@/lib/integrations/smileidentity")
    assertSmileIdentityRuntimeSafety()

    const APP_MODE = process.env.APP_MODE || "all"
    console.log(`[boot] APP_MODE=${APP_MODE} GIT_SHA=${process.env.GIT_SHA ?? "unknown"}`)

    // Cron jobs hit staff-only API routes (/api/cron/*) which the audience
    // gate 404s in client mode. Skipping registration on the client container
    // avoids noisy nightly 404 calls and keeps the portal container logs
    // free of misleading "cron failed" errors.
    if (APP_MODE === "client") {
      console.log("[cron] APP_MODE=client — scheduler skipped (staff container owns cron)")
      return
    }

    // A web replica of the Helm chart's worker/web split runs no jobs: only
    // singleRun jobs take a CronRunClaim, every other job fires on each
    // replica that schedules it, so the one worker replica owns them all.
    const { cronSchedulerEnabled } = await import("@/lib/ops/cron-scheduler-flag")
    if (!cronSchedulerEnabled(process.env)) {
      console.log("[cron] CRON_SCHEDULER=off — scheduler skipped (the worker owns cron)")
      return
    }

    // The fake-clock simulator calls cron routes in dated order itself.
    // A second scheduler reacts to clock jumps and duplicates those calls.
    if (process.env.DEMO_MODE === "true" && process.env.DEMO_SIM_MANUAL_CRON === "true") {
      console.log("[cron] demo simulator — explicit cron driver owns scheduling")
      return
    }

    const cron = await import("node-cron")

    // EVERY schedule below is pinned to SAST.
    //
    // The container sets no TZ (`date` reports UTC), so an unpinned
    // expression is read in UTC and fires TWO HOURS LATER than the comment
    // beside it claims — payment reminders at 09:00 SAST, not 07:00. A
    // schedule comment must describe the behaviour, so the timezone is explicit.
    const SAST = "Africa/Johannesburg"

    const CRON_SECRET = process.env.CRON_SECRET ?? ""
    if (!CRON_SECRET) {
      console.warn("[cron] CRON_SECRET is not configured; scheduler not registered")
      return
    }

    // Loaded once, before any job fires: two jobs firing in the same instant would
    // otherwise both be the first to import them.
    const claims = await import("@/lib/ops/cron-run-claim")
    const { callCronRoute, cronCallTarget } = await import("@/lib/ops/cron-call")
    const { recordCronOutcome } = await import("@/lib/observability/metrics")
    // Every in-process job, its schedule and its reason live in
    // lib/registry/cron-jobs/ (docs/ARCHITECTURE.md, "Registries"). Jobs the
    // deployment's external scheduler owns are declared there too and are
    // never scheduled here: both firing would duplicate NCA-mandated borrower
    // comms (Section 129 notices, payment reminders).
    const { CRON_JOBS } = await import("@/lib/registry/generated/cron-jobs")
    const occurrences = claims.cronOccurrences(CRON_JOBS.flatMap((job) => (job.owner === "in-process" ? [job] : [])))
    // This server on loopback, not the public origin and its proxy timeouts (lib/ops/cron-call.ts).
    const target = cronCallTarget(process.env)

    const callCron = async (
      path: string,
      method: "GET" | "POST" = "GET",
      singleRun = false,
      after: string | null = null,
    ) => {
      // Every replica fires every job, a single-run one also 30 and 60 minutes
      // after its time. It goes to the one replica that wins its SAST-day
      // claim (a DONE run is never repeated; a FAILED or dead one is taken
      // over by a later firing); the rest skip it without touching the
      // heartbeat, which the runner writes. A claim that cannot be made fails
      // closed: a skipped run shows on /api/health, a duplicate reminder or
      // Section 129 notice cannot be taken back.
      const claimKey = path.replace("/api/cron/", "")
      const claimedAt = new Date()
      let ownerToken: string | null = null
      // A job that reads another's results does not fire until that job has settled
      // today (DONE, or out of firings), and takes no claim while it waits: a later
      // firing of its own tries again.
      if (singleRun && after) {
        try {
          if (!(await claims.cronSettledToday(after, claims.finalFiringMinuteOfDay(occurrences, after)))) {
            console.log(`[cron] ${path} waits: ${after} has not settled today`)
            return
          }
        } catch (err) {
          console.error(`[cron] ${path} not run, could not read whether ${after} settled:`, err)
          return
        }
      }
      if (singleRun) {
        try {
          ownerToken = await claims.claimCronRun(claimKey, claimedAt)
        } catch (err) {
          console.error(`[cron] ${path} not run, run claim failed:`, err)
          return
        }
        if (!ownerToken) {
          console.log(`[cron] ${path} already claimed for today (done, or running elsewhere), skipping`)
          return
        }
      }
      // While the call is in flight, prove this runner is alive: a claim whose
      // heartbeat goes stale is how a later firing knows the runner died.
      let heartbeat: ReturnType<typeof setInterval> | undefined
      if (ownerToken) {
        const token = ownerToken
        heartbeat = setInterval(() => {
          claims.renewCronClaim(claimKey, token, claimedAt)
            .then((held) => {
              if (!held) console.error(`[cron] ${path} lost its run claim to another attempt; this run is no longer the owner`)
            })
            .catch((err) => console.error(`[cron] ${path} heartbeat failed:`, err))
        }, claims.HEARTBEAT_INTERVAL_MS)
      }
      const startedAt = new Date()
      let status: number | null = null
      let error: string | null = null
      let tenantFailed = false
      try {
        // No client timeout: see lib/ops/cron-call.ts.
        const res = await callCronRoute(`${target.baseUrl}${path}`, method, CRON_SECRET, target.host ? { host: target.host } : {})
        status = res.status
        // A single-run route says how many tenants threw in a header. A 2xx without it is not a clean
        // run: it cannot be told from a body that was too big to read, so it fails closed.
        tenantFailed = singleRun && (res.failedTenants === null || res.failedTenants > 0)
        if (status < 200 || status >= 300) {
          console.error(`[cron] ${path} failed: ${status}`)
        } else if (tenantFailed) {
          console.error(`[cron] ${path} ok, but ${res.failedTenants === null ? "it did not say whether a tenant failed" : `${res.failedTenants} tenant(s) threw`}; the claim is marked FAILED so a later firing retries it`)
        } else {
          console.log(`[cron] ${path} ok`)
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        console.error(`[cron] ${path} error:`, err)
      } finally {
        if (heartbeat) clearInterval(heartbeat)
      }
      if (ownerToken) {
        try {
          // DONE only for a 2xx in which no tenant's run threw; per-item errors
          // (a send that failed, a reconciliation case) are in the body and do not retry.
          const closed = await claims.finishCronRun(claimKey, ownerToken, status !== null && status >= 200 && status < 300 && !tenantFailed, claimedAt)
          if (!closed) console.error(`[cron] ${path} run claim was taken over before this run finished; its outcome is not recorded on the claim`)
        } catch (err) {
          console.error(`[cron] ${path} run claim not closed:`, err)
        }
      }
      recordCronOutcome(path, error !== null ? "error" : status !== null && status >= 200 && status < 300 ? (tenantFailed ? "tenant_failed" : "ok") : "failed")
      // The run's outcome for /api/health (lib/ops/cron-heartbeat.ts).
      try {
        const { recordCronRun } = await import("@/lib/ops/cron-heartbeat")
        await recordCronRun(path, { startedAt, status, error })
      } catch (err) {
        console.error(`[cron] ${path} heartbeat not recorded:`, err)
      }
    }

    for (const { job, schedule } of occurrences) {
      cron.schedule(schedule, () => callCron(`/api/cron/${job.route}`, job.method, job.singleRun, job.after), {
        timezone: SAST,
      })
    }
    const registered = occurrences.length

    console.log(`[cron] scheduler registered — ${registered} jobs active`)
  }
}
