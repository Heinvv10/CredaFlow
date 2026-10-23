import { NextRequest, NextResponse } from "next/server"
import { processPaymentReminders } from "@/lib/collections/reminders"
import { verifyCronSecret } from "@/lib/cron-auth"
import { FAILED_TENANTS_HEADER } from "@/lib/ops/cron-call"
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
  // The scheduler reads that count from the x-cron-failed-tenants HEADER (a body
  // past 1 MB is dropped) and marks the run FAILED so its +30 and +60 minute firings
  // retry it (the sends are deduped, so that is safe). The status is 503 only when
  // EVERY tenant threw, so one lender that fails nightly does not make the job look
  // permanently failed for the rest. That also means /api/health, which reads the
  // status, goes red for this job only on a single-tenant deployment or when every
  // tenant fails; a failing tenant among several is in the log, the body and the
  // claim (FAILED), not on health.
  const { status, partial } = sweepStatus({ tenants: result.tenants, failedTenants: result.failedTenants, otherErrors: 0 })
  return NextResponse.json({ ok: status === 200, partial, ...result }, { status, headers: { [FAILED_TENANTS_HEADER]: String(result.failedTenants) } })
}
