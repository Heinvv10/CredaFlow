import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { runWithTenant } from "@/lib/tenant-scope"
import { snapshotTenantArrears } from "@/lib/reports/arrears-snapshot"

/**
 * Nightly arrears history: one LoanArrearsSnapshot row per collectible loan of
 * every tenant for today's SAST date, plus that day's run marker (lib/reports/arrears-snapshot.ts), which
 * the NCR return reads at quarter end. Idempotent per day: a second run the
 * same day writes nothing new. Scheduled late in the SAST day so the row
 * describes the day it is dated.
 *
 * Any failed tenant makes the response 503: the scheduler treats only a
 * non-2xx as a failure.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const asOf = new Date()
  // Tenant is not a tenant-scoped model, so listing tenants needs no frame
  // (Loan is: a cross-tenant loan query here threw missing-context). Every
  // tenant, suspended ones too: a lender's quarterly return is still due, and
  // a day the run marker records with an empty book is a position too.
  const tenants = await prisma.tenant.findMany({ select: { id: true }, orderBy: { id: "asc" } })

  const perTenant: Array<{ tenantId: string; snapshotDate?: string; loans?: number; written?: number; error?: string }> = []
  for (const { id: tenantId } of tenants) {
    try {
      perTenant.push({ tenantId, ...await runWithTenant(tenantId, () => snapshotTenantArrears(tenantId, asOf)) })
    } catch (error) {
      perTenant.push({ tenantId, error: error instanceof Error ? error.message : String(error) })
    }
  }

  const ok = perTenant.every((t) => !t.error)
  return NextResponse.json({ ok, runAt: asOf.toISOString(), perTenant }, { status: ok ? 200 : 503 })
}
