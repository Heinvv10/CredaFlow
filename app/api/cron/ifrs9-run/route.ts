import { NextRequest, NextResponse } from "next/server"
import { verifyCronSecret } from "@/lib/cron-auth"
import { sastCalendarDate } from "@/lib/date/sast"
import { Ifrs9RunError, executeRun } from "@/lib/ifrs9/run"
import { monthlyRunTarget } from "@/lib/ifrs9/period"
import { loadSettings } from "@/lib/ifrs9/store"
import { prisma } from "@/lib/prisma"
import { sweepActiveTenants, sweepStatus } from "@/lib/ops/tenant-sweep"

/**
 * IFRS 9 month-end run: on the last SAST day of the month, every ACTIVE tenant that has IFRS 9
 * enabled gets its MONTHLY staging run (lib/ifrs9/run.ts); in the first five days of the next month
 * it makes up a tenant's run that is missing (a failure that night), at that day's position. On any
 * other day it does nothing and answers 200, so the scheduler's heartbeat stays fresh. Idempotent per
 * tenant per month.
 */
export async function GET(req: NextRequest) {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const now = new Date()
  const today = sastCalendarDate(now)
  const periodKey = monthlyRunTarget(today)
  if (!periodKey) return NextResponse.json({ ok: true, ran: false, reason: "not the last day of the month, nor in the first five days of the next", today })

  const outcomes = await sweepActiveTenants("ifrs9-run", async (tenant) => {
    const settings = await loadSettings(prisma, tenant.id)
    if (!settings.enabled || (settings.effectiveFromMonth && periodKey < settings.effectiveFromMonth)) return null
    try {
      return await executeRun(tenant.id, { kind: "MONTHLY", periodKey, now })
    } catch (error) {
      // A month that closed before IFRS 9 governed it needs no run.
      if (error instanceof Ifrs9RunError && error.code === "PERIOD_CLOSED") return null
      throw error
    }
  })
  const perTenant = outcomes.map((o) => (o.ok
    ? { tenantId: o.tenant.id, run: o.value }
    : { tenantId: o.tenant.id, error: "failed; see the server log" }))
  const failedTenants = outcomes.filter((o) => !o.ok).length
  const { status, partial } = sweepStatus({ tenants: outcomes.length, failedTenants, otherErrors: 0 })
  return NextResponse.json({ ok: status === 200, partial, ran: true, today, failedTenants, perTenant }, { status })
}
