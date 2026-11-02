import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sastCalendarDate } from "@/lib/date/sast"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { sweepActiveTenants, sweepStatus } from "@/lib/ops/tenant-sweep"
import { repriceTenantLoans } from "@/lib/product-engine/reprice-batch"

/**
 * Variable-rate loans whose reference moved: each approved value that took effect is applied to the loans on it
 * (lib/product-engine/reprice-batch.ts). Idempotent per loan and effective date; sends nothing. No NCA lender has one: its
 * agreement states a fixed rate, so the job stands down there rather than rely on no such loan existing.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) return NextResponse.json({ skipped: "an NCA lender has no variable-rate loans" })

  const today = sastCalendarDate(new Date())
  const outcomes = await sweepActiveTenants("loan-rate-reprice", (tenant) => repriceTenantLoans(tenant.id, today))
  const perTenant = outcomes.map((o) => (o.ok ? { tenantId: o.tenant.id, ...o.value } : { tenantId: o.tenant.id, error: "failed; see the server log" }))
  const failedTenants = outcomes.filter((o) => !o.ok).length
  const failedLoans = outcomes.reduce((n, o) => n + (o.ok ? o.value.failed : 0), 0)
  const { status, partial } = sweepStatus({ tenants: outcomes.length, failedTenants, otherErrors: failedLoans })
  return NextResponse.json({ ok: status === 200, partial, today, failedTenants, failedLoans, perTenant }, { status })
}
