import { NextRequest, NextResponse } from "next/server"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { verifyCronSecret } from "@/lib/cron-auth"

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
  const ok = result.errors === 0 && result.reconciliationRequired === 0
  return NextResponse.json({ ok, ...result }, { status: ok ? 200 : 503 })
}
