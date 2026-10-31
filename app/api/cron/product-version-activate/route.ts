import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sastCalendarDate } from "@/lib/date/sast"
import { activateDueVersions } from "@/lib/product-engine/activate"
import { prisma } from "@/lib/prisma"
import { sweepActiveTenants, sweepStatus } from "@/lib/ops/tenant-sweep"

/**
 * Product versions that came into effect: every ACTIVE tenant has LoanProduct made equal to the version in effect for
 * each product whose version is due (lib/product-engine/activate.ts). Idempotent (a version is applied once) and sends
 * nothing. Approval prices on the version in effect, so a night missed changes nothing for an application.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const today = sastCalendarDate(new Date())
  const outcomes = await sweepActiveTenants("product-version-activate", (tenant) =>
    prisma.$transaction((tx) => activateDueVersions(tx, tenant.id, today, null)))
  const perTenant = outcomes.map((o) => (o.ok
    ? {
        tenantId: o.tenant.id,
        activated: o.value.activated.map((a) => ({ productId: a.productId, version: a.version, skipped: a.skipped })),
        // Versions an NCA lender may not use today (the cap moved): left unapplied, tried again tomorrow. A person has to propose another.
        blocked: o.value.blocked.map((b) => ({ productId: b.productId, version: b.version, issues: b.issues })),
      }
    : { tenantId: o.tenant.id, error: "failed; see the server log" }))
  const failedTenants = outcomes.filter((o) => !o.ok).length
  const { status, partial } = sweepStatus({ tenants: outcomes.length, failedTenants, otherErrors: 0 })
  return NextResponse.json({ ok: status === 200, partial, today, failedTenants, perTenant }, { status })
}
