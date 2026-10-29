import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { readJson, totpWriteRefusal } from "@/lib/accounting/route-helpers"
import { Ifrs9RunError, currentMonthlyRun, executeRun } from "@/lib/ifrs9/run"

// The month's official run, when the month-end job did not make it right: ADMIN, TOTP when required, audited.
// POST { periodKey, reason } adds the run of an ended month that has none (a late run, flagged as such);
// POST { periodKey, reason, supersedesRunId } replaces the month's current run with a new one. Both only while the
// accounting month is open: the position is rebuilt as at the month's last day, and the replaced run stays on record.

const CONFLICTS = new Set(["PARAMETERS_MISSING", "PERIOD_CLOSED", "SUPERSEDE_STALE", "PREVIOUS_MONTH_MISSING"])

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const refusal = await totpWriteRefusal(tenant.id, guard.user, "make an IFRS 9 monthly run")
    if (refusal) return refusal
    const read = await readJson(req)
    if (!read.ok) return read.response
    const { periodKey, reason, supersedesRunId } = (read.body ?? {}) as Record<string, unknown>
    if (typeof periodKey !== "string") return NextResponse.json({ error: "periodKey must be yyyy-mm" }, { status: 400 })
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500) return NextResponse.json({ error: "reason is required (at most 500 characters)" }, { status: 400 })
    if (supersedesRunId !== undefined && typeof supersedesRunId !== "string") return NextResponse.json({ error: "supersedesRunId must be a run id" }, { status: 400 })
    const current = await currentMonthlyRun(prisma, tenant.id, periodKey)
    if (current && supersedesRunId === undefined) {
      return NextResponse.json({ error: `${periodKey} already has a run; name it in supersedesRunId to replace it`, currentRunId: current.id }, { status: 409 })
    }
    try {
      const run = await executeRun(tenant.id, {
        kind: "MONTHLY", periodKey, actor: guard.user, lateReason: reason.trim(),
        supersede: supersedesRunId === undefined ? undefined : { runId: supersedesRunId, reason: reason.trim() },
      })
      return NextResponse.json(run, { status: 201 })
    } catch (error) {
      if (error instanceof Ifrs9RunError) return NextResponse.json({ error: error.message, code: error.code }, { status: CONFLICTS.has(error.code) ? 409 : 400 })
      throw error
    }
  })
}
