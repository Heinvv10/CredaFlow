import { defineCronJobs } from "../define"

export default defineCronJobs([
  // Every 5 minutes — poll the WhatsApp bridge and alert when it is down.
  // In-process rather than an external timer is deliberate: it wires itself on
  // every deploy, which is the entire point of a monitor. A route with no
  // scheduler never runs, so a timer that is not wired on the host is the same
  // gap. The route itself no-ops safely in any environment without
  // WA_SENDER_URL configured rather than firing a false alert.
  { route: "check-wa-bridge-status", owner: "in-process", schedule: "*/5 * * * *", freshnessMinutes: 15 },
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
  // both exist. (It was once listed as unwired, "blocked on Meta WABA review";
  // that stopped being true when the WABA went live on 2026-08-11.)
  { route: "poll-wa-templates", owner: "in-process", schedule: "*/15 * * * *", freshnessMinutes: 45 },
] as const)
