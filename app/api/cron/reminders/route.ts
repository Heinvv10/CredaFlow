import { NextRequest, NextResponse } from "next/server"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sweepStatus } from "@/lib/ops/tenant-sweep"

export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const result = await processPaymentReminders()

  // `errors` (a send that failed, a missing Contact row), `reconciliationRequired`
  // (an ambiguous provider outcome held for a human) and `warnings` (a leg skipped
  // for the tenant) are per-item outcomes: they are in the body, and they leave the
  // response 200. A retry would not fix them, and a 503 every day would hide the one
  // failure a retry is for: a tenant whose whole run threw (`failedTenants`).
  // The scheduler reads that count from the body and marks the run FAILED so its
  // +30 and +60 minute firings retry it (the sends are deduped, so that is safe),
  // but the status is 503 only when EVERY tenant threw, so one lender that fails
  // nightly does not make the job look permanently failed for the rest.
  const { status, partial } = sweepStatus({ tenants: result.tenants, failedTenants: result.failedTenants, otherErrors: 0 })
  return NextResponse.json({ ok: status === 200, partial, ...result }, { status })
}
