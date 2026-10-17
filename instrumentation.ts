export async function register() {
  // Only run scheduler in Node.js runtime (not edge), and only in a server context
  if (process.env.NEXT_RUNTIME === "nodejs") {
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

    const BASE_URL = process.env.NEXTAUTH_URL ?? `http://localhost:${process.env.PORT ?? 3300}`
    const CRON_SECRET = process.env.CRON_SECRET ?? ""
    if (!CRON_SECRET) {
      console.warn("[cron] CRON_SECRET is not configured; scheduler not registered")
      return
    }

    const callCron = async (
      path: string,
      method: "GET" | "POST" = "GET",
    ) => {
      const startedAt = new Date()
      let status: number | null = null
      let error: string | null = null
      try {
        const headers: Record<string, string> = { "x-cron-secret": CRON_SECRET }

        const res = await fetch(`${BASE_URL}${path}`, { method, headers })
        status = res.status
        if (!res.ok) {
          console.error(`[cron] ${path} failed: ${res.status}`)
        } else {
          console.log(`[cron] ${path} ok`)
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err)
        console.error(`[cron] ${path} error:`, err)
      }
      // The run's outcome for /api/health (lib/ops/cron-heartbeat.ts).
      try {
        const { recordCronRun } = await import("@/lib/ops/cron-heartbeat")
        await recordCronRun(path, { startedAt, status, error })
      } catch (err) {
        console.error(`[cron] ${path} heartbeat not recorded:`, err)
      }
    }

    // Every in-process job, its schedule and its reason live in
    // lib/registry/cron-jobs/ (docs/ARCHITECTURE.md, "Registries"). Jobs the
    // deployment's external scheduler owns are declared there too and are
    // never scheduled here: both firing would duplicate NCA-mandated borrower
    // comms (Section 129 notices, payment reminders).
    const { CRON_JOBS } = await import("@/lib/registry/generated/cron-jobs")
    let registered = 0
    for (const job of CRON_JOBS) {
      if (job.owner !== "in-process") continue
      cron.schedule(job.schedule, () => callCron(`/api/cron/${job.route}`, job.method), {
        timezone: SAST,
      })
      registered++
    }

    console.log(`[cron] scheduler registered — ${registered} jobs active`)
  }
}
