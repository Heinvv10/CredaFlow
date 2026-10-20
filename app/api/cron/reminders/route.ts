import { NextRequest, NextResponse } from "next/server"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sweepStatus } from "@/lib/collections/tenant-sweep"

export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await processPaymentReminders()

  // `errors` is the curated failure counter inside processPaymentReminders —
  // it deliberately excludes SendBlockedError (consent/opt-out, correct
  // behaviour) and reconciliation-required outcomes, which get their own
  // counter. `reconciliationRequired` is a row the sweep could NOT resolve on
  // its own (a known-dispatch persistence gap or an ambiguous provider
  // outcome — see lib/collections/reminders.ts) and needs a human to look at
  // the queue, the same shape as messaging-retry's manualReconciliation. A
  // hardcoded 200 here would hide either from the systemd wrapper, which
  // calls this with `curl -fsS` — only fails the unit on HTTP >= 400 and
  // never parses this body.
  //
  // A tenant whose whole run threw is counted in `errors` and named in
  // `details`, but only turns the response 503 when every tenant failed
  // (sweepStatus): one lender that fails nightly must not make the job look
  // permanently failed for the rest.
  const { status, partial } = sweepStatus({
    tenants: result.tenants,
    failedTenants: result.failedTenants,
    otherErrors: result.errors - result.failedTenants + result.reconciliationRequired,
  })
  return NextResponse.json({ ok: status === 200, partial, ...result }, { status })
}
