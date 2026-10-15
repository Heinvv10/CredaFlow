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

    // OWNERSHIP RULE: dpd-update, reminders, and escalations are NOT
    // scheduled here. The deployment must schedule them (an external scheduler
    // calling /api/cron/dpd-update, /api/cron/reminders and
    // /api/cron/escalations with the cron secret); nothing in this repo does,
    // so a deployment without that scheduler never runs them.
    // Do NOT re-add cron.schedule() calls for these routes here: with an
    // external scheduler in place they would fire twice nightly, which risks
    // duplicate NCA-mandated borrower comms (Section 129 notices, payment
    // reminders).

    // Nightly at 07:00 — send payment reminder emails (3-day-before)
    cron.schedule("0 7 * * *", () => callCron("/api/cron/payment-reminders"), {
      timezone: SAST,
    })

    // Nightly at 06:00 — insurance renewal reminders (30-day warning)
    cron.schedule("0 6 * * *", () => callCron("/api/cron/insurance-renewal", "POST"), {
      timezone: SAST,
    })

    // Weekly Sunday at 03:00 — cross-sell opportunity evaluation
    cron.schedule("0 3 * * 0", () => callCron("/api/cron/cross-sell", "POST"), {
      timezone: SAST,
    })

    // Weekly Sunday at 04:00 — flag dormant clients for re-engagement
    cron.schedule("0 4 * * 0", () => callCron("/api/cron/dormant-clients", "POST"), {
      timezone: SAST,
    })

    // Daily at 08:30 — alert agents with stale leads (48h+ no activity)
    cron.schedule("30 8 * * *", () => callCron("/api/cron/stale-leads-alert"), {
      timezone: SAST,
    })

    // Daily at 06:00 — evaluate all active payment arrangements (kept/broken/completed)
    cron.schedule("0 6 * * *", () => callCron("/api/cron/arrangement-check"), {
      timezone: SAST,
    })

    // Daily at 05:15 SAST — FAIS Fit & Proper adviser licence expiry (60-day
    // warning). It is scheduled here
    // rather than as a systemd timer because no unit owns it (the ownership
    // rule above covers only dpd-update, reminders and escalations), so there
    // is nothing for an in-process schedule to double-fire against.
    //
    // The timezone is explicit because the container sets no TZ, so node-cron
    // would otherwise read this expression in the image's UTC and fire at
    // 07:15 SAST — making the comment above a false statement about when the
    // job runs.
    cron.schedule("15 5 * * *", () => callCron("/api/cron/licence-expiry"), {
      timezone: SAST,
    })

    // Every 5 minutes — poll the WhatsApp bridge and alert when it is down.
    // In-process rather than a systemd timer (unlike the OWNERSHIP RULE
    // block above) is deliberate: it wires itself on every deploy, which is
    // the entire point of a monitor. A route with no scheduler
    // never runs, so a timer that is not wired on the host is the same gap.
    // The route itself no-ops safely in any environment without WA_SENDER_URL
    // configured rather than firing a false alert.
    cron.schedule("*/5 * * * *", () => callCron("/api/cron/check-wa-bridge-status"), {
      timezone: SAST,
    })

    // Every 15 minutes — advance PENDING WABA templates to their Meta status.
    //
    // lib/whatsapp/template-submit.ts writes PENDING and stops, so without a
    // poll a template's status never advances on its own. The
    // `message_template_status_update` webhook now handles this too
    // (lib/whatsapp/template-status.ts) and is the faster path; this poll is
    // the belt for a lost subscription or a missed delivery. Since
    // lib/whatsapp-cloud.ts gates every template send on
    // `providerStatus === "APPROVED"`, leaving this unscheduled means a
    // template Meta has approved stays PENDING here forever and every
    // system-initiated WhatsApp fails WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE while
    // the dashboard shows "Approved".
    //
    // The route early-returns on its first query when nothing is PENDING, so
    // it is cheap to keep wired ahead of any submission; submissions then
    // cannot land into a gap.
    //
    // NOTE: this re-polls PENDING rows only, so Meta's later
    // APPROVED -> PAUSED / DISABLED transitions cannot land through it. Those
    // arrive via the `message_template_status_update` webhook, which is why
    // both exist.
    cron.schedule("*/15 * * * *", () => callCron("/api/cron/poll-wa-templates"), {
      timezone: SAST,
    })

    // Default interest and post-default charges (lib/loan/charges-sweep.ts).
    // Idle unless TenantConfig.defaultChargesEnabled is on for a tenant.
    // Nightly, after SAST midnight, so the completed day has accrued.
    cron.schedule("30 1 * * *", () => callCron("/api/cron/default-charges"), {
      timezone: SAST,
    })

    // Closes website chats idle for 24h unless handed off to staff
    // (lib/website-chat/auto-close.ts). Hourly, so a chat closes within an
    // hour of reaching the limit.
    cron.schedule("20 * * * *", () => callCron("/api/cron/website-chat-close"), {
      timezone: SAST,
    })

    // Times out website-chat hand-offs nobody joined and emails staff about
    // them (lib/website-chat/handoff-sweep.ts). Every minute: the visitor is
    // told within two minutes, so the email must not lag far behind.
    cron.schedule("* * * * *", () => callCron("/api/cron/website-chat-handoffs"), {
      timezone: SAST,
    })

    // Asset finance: re-solves reference-linked contracts for reference-rate
    // changes that took effect (lib/asset-finance/reprice-batch.ts). Idempotent
    // per (loan, effective date); idle for tenants without featureAssetFinance.
    cron.schedule("45 1 * * *", () => callCron("/api/cron/asset-finance-reprice"), {
      timezone: SAST,
    })

    // Asset-finance leases: the tax invoice of every rental that fell due
    // (lib/asset-finance/lease-invoice-batch.ts). After the repricing run, so a
    // rental repriced today is invoiced at its new amount. Idempotent.
    cron.schedule("15 2 * * *", () => callCron("/api/cron/asset-finance-lease-invoices"), {
      timezone: SAST,
    })

    // PEP / sanctions re-screen of active clients whose latest run is older
    // than SCREENING_MAX_AGE_DAYS (lib/screening/refresh.ts). Idle for tenants
    // without TenantConfig.screeningProvider. Nightly, outside business hours,
    // because each client is a provider call.
    cron.schedule("15 2 * * *", () => callCron("/api/cron/screening-refresh"), {
      timezone: SAST,
    })

    // Outbound lender webhooks (lib/lender-api/webhooks/dispatch.ts): fans out
    // new outbox events and POSTs due deliveries with retry backoff. Every
    // minute; idle for tenants without an active endpoint.
    cron.schedule("* * * * *", () => callCron("/api/cron/webhook-deliveries"), {
      timezone: SAST,
    })

    // Lender API retention (lib/lender-api/retention.ts): prunes old API
    // request logs and finished webhook deliveries. Nightly, off-peak.
    cron.schedule("15 3 * * *", () => callCron("/api/cron/lender-api-retention"), {
      timezone: SAST,
    })

    // Fails selfie attempts stuck in `processing` past 15 minutes (a worker that
    // died mid-VLM-call) so the client can retake (lib/kyc/selfie-sweeper.server.ts).
    // Every 5 minutes: a stuck client waits at most 20.
    cron.schedule("*/5 * * * *", () => callCron("/api/cron/sweep-stuck-selfies"), {
      timezone: SAST,
    })

    console.log("[cron] scheduler registered — 18 jobs active")
  }
}
